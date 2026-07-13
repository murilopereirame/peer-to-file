//! A local, loopback-only reverse proxy the webview's WebTorrent client
//! talks to instead of the real (arbitrary, user-entered) peer-to-file
//! server directly.
//!
//! The webview enforces real browser CORS; the peer-to-file server's `*`
//! `Access-Control-Allow-Origin` doesn't permit the credentialed/"complex"
//! requests WebTorrent's webseed (Range requests) and tracker (WebSocket)
//! connections need, from an origin (`tauri://localhost` / `https://
//! tauri.localhost`) that never matches the server's own. This proxy sits
//! on `127.0.0.1` and answers with permissive CORS headers of its own, so
//! the webview is happy — it forwards the actual bytes/frames to and from
//! the real server using Rust's HTTP/WebSocket clients, which have no CORS
//! concept at all (same reason the rest of this app's networking already
//! goes through `tauri-plugin-http` instead of the webview's own `fetch`).
//!
//! Once the tracker handshake completes through here, the resulting WebRTC
//! data channel is a genuine direct peer-to-peer connection between the
//! webview and the server — it doesn't route through this proxy, or
//! through Rust at all.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;

#[derive(Clone)]
struct ProxyState {
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct TargetQuery {
    target: String,
}

fn cors(builder: axum::http::response::Builder) -> axum::http::response::Builder {
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
        .header(
            "access-control-allow-headers",
            "Range, Authorization, Content-Type",
        )
        .header(
            "access-control-expose-headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
}

async fn options_handler() -> Response {
    cors(Response::builder().status(StatusCode::NO_CONTENT))
        .body(Body::empty())
        .expect("building a static CORS preflight response")
}

/// Proxies the webseed GET (`/api/raw?path=...&t=...`) — forwards the
/// incoming `Range` header (WebTorrent fetches specific byte ranges per
/// piece) and streams the response straight through without buffering it.
async fn http_proxy(
    State(state): State<ProxyState>,
    Query(query): Query<TargetQuery>,
    headers: HeaderMap,
) -> Response {
    let mut req = state.http.get(&query.target);
    if let Some(range) = headers.get(header::RANGE) {
        req = req.header(header::RANGE, range.clone());
    }

    let upstream = match req.send().await {
        Ok(res) => res,
        Err(err) => {
            return cors(Response::builder().status(StatusCode::BAD_GATEWAY))
                .body(Body::from(err.to_string()))
                .expect("building an error response body");
        }
    };

    let status = upstream.status();
    let mut builder = cors(Response::builder().status(status));
    for name in [
        "content-length",
        "content-range",
        "accept-ranges",
        "content-type",
    ] {
        if let Some(value) = upstream.headers().get(name) {
            builder = builder.header(name, value.clone());
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .expect("building a streamed proxy response")
}

async fn ws_proxy(ws: WebSocketUpgrade, Query(query): Query<TargetQuery>) -> Response {
    ws.on_upgrade(move |socket| relay(socket, query.target))
}

/// Relays the tracker's WebSocket signaling connection (BEP-style
/// announce/offer/answer JSON messages) — just the handshake; the actual
/// transfer happens over a direct WebRTC data channel afterwards.
async fn relay(client_socket: WebSocket, target: String) {
    let Ok((upstream, _)) = tokio_tungstenite::connect_async(&target).await else {
        return;
    };
    let (mut client_tx, mut client_rx) = client_socket.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    let client_to_upstream = async {
        while let Some(Ok(msg)) = client_rx.next().await {
            let closing = matches!(msg, Message::Close(_));
            if upstream_tx.send(to_tungstenite(msg)).await.is_err() || closing {
                break;
            }
        }
    };
    let upstream_to_client = async {
        while let Some(Ok(msg)) = upstream_rx.next().await {
            let closing = matches!(msg, tungstenite::Message::Close(_));
            if let Some(converted) = to_axum(msg) {
                if client_tx.send(converted).await.is_err() {
                    break;
                }
            }
            if closing {
                break;
            }
        }
    };
    tokio::select! {
        _ = client_to_upstream => {}
        _ = upstream_to_client => {}
    }
}

fn to_tungstenite(msg: Message) -> tungstenite::Message {
    match msg {
        Message::Text(text) => tungstenite::Message::Text(text.to_string().into()),
        Message::Binary(data) => tungstenite::Message::Binary(data.to_vec().into()),
        Message::Ping(data) => tungstenite::Message::Ping(data.to_vec().into()),
        Message::Pong(data) => tungstenite::Message::Pong(data.to_vec().into()),
        Message::Close(frame) => {
            tungstenite::Message::Close(frame.map(|f| tungstenite::protocol::CloseFrame {
                code: f.code.into(),
                reason: f.reason.to_string().into(),
            }))
        }
    }
}

fn to_axum(msg: tungstenite::Message) -> Option<Message> {
    match msg {
        tungstenite::Message::Text(text) => Some(Message::Text(text.to_string().into())),
        tungstenite::Message::Binary(data) => Some(Message::Binary(data.to_vec().into())),
        tungstenite::Message::Ping(data) => Some(Message::Ping(data.to_vec().into())),
        tungstenite::Message::Pong(data) => Some(Message::Pong(data.to_vec().into())),
        tungstenite::Message::Close(frame) => Some(Message::Close(frame.map(|f| {
            axum::extract::ws::CloseFrame {
                code: f.code.into(),
                reason: f.reason.to_string().into(),
            }
        }))),
        // A raw, not-yet-fully-parsed frame — shouldn't surface from a
        // completed-message stream; nothing meaningful to forward.
        tungstenite::Message::Frame(_) => None,
    }
}

/// Binds an OS-assigned loopback port (so a second instance, or a port
/// already in use, doesn't fail the whole app) and starts serving. Returns
/// the port so the frontend can build proxied URLs against it.
pub async fn start() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    let state = ProxyState {
        http: reqwest::Client::new(),
    };
    let app = Router::new()
        .route("/proxy", get(http_proxy).options(options_handler))
        .route("/proxy/ws", get(ws_proxy))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("local proxy server error: {err}");
        }
    });

    Ok(port)
}

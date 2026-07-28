import { formatBytes } from '../lib/format'
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, SearchIcon } from './icons'

export function TopBar ({
  title, subtitle, search, onSearch, searchPlaceholder, downSpeed, upSpeed
}: {
  title: string
  subtitle: string
  search: string
  onSearch: (value: string) => void
  searchPlaceholder: string
  downSpeed: number
  upSpeed: number
}): React.JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar-title">
        <h2>{title}</h2>
        <span className="subtitle">{subtitle}</span>
      </div>

      <div className="search-field">
        <SearchIcon className="search-icon" size={15} />
        <input
          type="search"
          value={search}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={e => onSearch(e.target.value)}
        />
        {search !== '' && (
          <button
            type="button" className="icon-btn clear-search" title="Clear search" aria-label="Clear search"
            onClick={() => onSearch('')}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </div>

      {/* Live totals across every transfer, mirrored by the graphs on the
          Transfers view. */}
      <div className="speed-readout">
        <span className="rate down" title="Total download speed">
          <ArrowDownIcon size={15} />{formatBytes(downSpeed)}/s
        </span>
        <span className="rate up" title="Total upload speed">
          <ArrowUpIcon size={15} />{formatBytes(upSpeed)}/s
        </span>
      </div>
    </div>
  )
}

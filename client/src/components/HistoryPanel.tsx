import { useDownloadHistory } from '../hooks/useDownloadHistory'
import { useToast } from '../context/ToastContext'
import { HistoryCard } from './HistoryCard'
import { DownloadIcon } from './icons'

export function HistoryPanel ({
  refreshSignal, search = ''
}: {
  refreshSignal: unknown
  search?: string
}): React.JSX.Element {
  const { entries, loading, error, clear } = useDownloadHistory(refreshSignal)
  const notify = useToast()

  const onClear = (): void => {
    if (!window.confirm('Clear your download history? This only affects the history list — nothing on disk is touched.')) return
    void clear().then(() => notify('Download history cleared'))
  }

  return (
    <HistoryCard
      id="history-panel"
      listId="history-list"
      title="Download history"
      icon={<DownloadIcon size={15} />}
      emptyText="no downloads yet"
      entries={entries}
      loading={loading}
      error={error}
      search={search}
      onClear={onClear}
      showHash
    />
  )
}

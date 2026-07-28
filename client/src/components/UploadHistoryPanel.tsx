import { useUploadHistory } from '../hooks/useUploadHistory'
import { useToast } from '../context/ToastContext'
import { HistoryCard } from './HistoryCard'
import { UploadIcon } from './icons'

export function UploadHistoryPanel ({
  refreshSignal, search = ''
}: {
  refreshSignal: unknown
  search?: string
}): React.JSX.Element {
  const { entries, loading, error, clear } = useUploadHistory(refreshSignal)
  const notify = useToast()

  const onClear = (): void => {
    if (!window.confirm('Clear your upload history? This only affects the history list — nothing on disk is touched.')) return
    void clear().then(() => notify('Upload history cleared'))
  }

  return (
    <HistoryCard
      id="upload-history-panel"
      listId="upload-history-list"
      title="Upload history"
      icon={<UploadIcon size={15} />}
      emptyText="no uploads yet"
      entries={entries}
      loading={loading}
      error={error}
      search={search}
      onClear={onClear}
    />
  )
}

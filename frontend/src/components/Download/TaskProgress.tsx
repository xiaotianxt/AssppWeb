import { useTranslation } from 'react-i18next';
import Badge from '../common/Badge';
import ProgressBar from '../common/ProgressBar';
import { formatBytes } from '../../utils/format';
import type { DownloadTask } from '../../types';

export function TaskStatusBadge({ task }: { task: DownloadTask }) {
  const { t } = useTranslation();
  const phase =
    task.status === 'uploading' ? task.uploadProgress?.phase : undefined;
  const label =
    phase && phase !== 'uploading' ? t(`downloads.upload.${phase}`) : undefined;
  return <Badge status={task.status} label={label} />;
}

export default function TaskProgress({
  task,
  className = '',
}: {
  task: DownloadTask;
  className?: string;
}) {
  const { t } = useTranslation();
  const textClass = 'text-xs font-medium text-gray-600 dark:text-gray-400';

  if (task.status === 'uploading') {
    const progress = task.uploadProgress;
    // Never present the previous download's 100% as upload progress. Old
    // servers without byte counters get an honest, indeterminate status.
    if (
      !progress ||
      progress.phase !== 'uploading' ||
      progress.totalBytes <= 0
    ) {
      const phase = progress?.phase ?? 'preparing';
      return (
        <div className={`${className} ${textClass}`} role="status">
          {t(
            `downloads.upload.${phase === 'uploading' ? 'preparing' : phase}Hint`,
          )}
        </div>
      );
    }
    const percent = Math.floor(
      (progress.uploadedBytes / progress.totalBytes) * 100,
    );
    return (
      <div className={className}>
        <ProgressBar
          progress={percent}
          label={`${task.software.name} — ${t('downloads.status.uploading')}`}
        />
        <div
          className={`mt-1.5 flex flex-wrap justify-between gap-x-3 gap-y-1 ${textClass}`}
        >
          <span>
            {percent}% · {formatBytes(progress.uploadedBytes)} /{' '}
            {formatBytes(progress.totalBytes)}
          </span>
          <span>
            {progress.bytesPerSecond > 0
              ? `${formatBytes(progress.bytesPerSecond)}/s`
              : t('downloads.upload.measuringSpeed')}
          </span>
        </div>
      </div>
    );
  }

  if (task.status === 'injecting') {
    return (
      <div className={`${className} ${textClass}`} role="status">
        {t('downloads.status.injecting')}
      </div>
    );
  }
  if (task.status !== 'downloading' && task.status !== 'paused') return null;
  return (
    <div className={className}>
      <ProgressBar progress={task.progress} label={task.software.name} />
      <div className={`mt-1.5 flex min-w-0 justify-between gap-3 ${textClass}`}>
        <span>{Math.round(task.progress)}%</span>
        {task.status === 'downloading' && task.speed && (
          <span className="truncate text-right">{task.speed}</span>
        )}
      </div>
    </div>
  );
}

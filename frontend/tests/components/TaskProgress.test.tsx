import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TaskProgress, {
  TaskStatusBadge,
} from '../../src/components/Download/TaskProgress';
import type { DownloadTask, UploadProgress } from '../../src/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
afterEach(cleanup);

function task(progress?: UploadProgress): DownloadTask {
  return {
    id: 'test',
    software: { name: 'App' },
    status: 'uploading',
    progress: 100,
    speed: '0 B/s',
    uploadProgress: progress,
  } as DownloadTask;
}

it.each(['queued', 'verifying'] as const)(
  'shows %s without a fake completed transfer bar or speed',
  (phase) => {
    const value = task({
      phase,
      uploadedBytes: phase === 'queued' ? 0 : 100,
      totalBytes: 100,
      bytesPerSecond: 0,
    });
    render(
      <>
        <TaskStatusBadge task={value} />
        <TaskProgress task={value} />
      </>,
    );
    expect(screen.getByText(`downloads.upload.${phase}`)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      `downloads.upload.${phase}Hint`,
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/100%|0 B\/s/)).not.toBeInTheDocument();
  },
);

it('renders acknowledged bytes and measured speed instead of the old download progress', () => {
  const value = task({
    phase: 'uploading',
    uploadedBytes: 4 * 1024 ** 2,
    totalBytes: 8 * 1024 ** 2,
    bytesPerSecond: 1024 ** 2,
  });
  render(<TaskProgress task={value} />);
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '50',
  );
  expect(screen.getByText('50% · 4.0 MB / 8.0 MB')).toBeInTheDocument();
  expect(screen.getByText('1.0 MB/s')).toBeInTheDocument();
});

it('does not round an unfinished upload up to 100%', () => {
  render(
    <TaskProgress
      task={task({
        phase: 'uploading',
        uploadedBytes: 999,
        totalBytes: 1000,
        bytesPerSecond: 0,
      })}
    />,
  );
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuenow',
    '99',
  );
  expect(
    screen.getByText('downloads.upload.measuringSpeed'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/100%|0 B\/s/)).not.toBeInTheDocument();
});

it('treats missing counters from an older server as indeterminate, not 100%', () => {
  render(<TaskProgress task={task()} />);
  expect(screen.getByRole('status')).toHaveTextContent(
    'downloads.upload.preparingHint',
  );
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

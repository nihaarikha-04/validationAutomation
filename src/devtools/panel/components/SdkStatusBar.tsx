import type { SdkStatus } from '../../../shared/sdk';

export interface SdkStatusBarProps {
  readonly hostname: string;
  /** `undefined` while the retry loop is still running. */
  readonly status: SdkStatus | undefined;
}

export function SdkStatusBar({ hostname, status }: SdkStatusBarProps) {
  return (
    <header className="status">
      <dl className="status__grid">
        <div className="status__item">
          <dt>Site</dt>
          <dd>{hostname === '' ? '—' : hostname}</dd>
        </div>
        <div className="status__item">
          <dt>SDK</dt>
          <dd>{describeSdk(status)}</dd>
        </div>
        <div className="status__item">
          <dt>Debug</dt>
          <dd>{describeDebug(status)}</dd>
        </div>
      </dl>
      {status?.kind === 'absent' ? (
        <p className="status__diagnostic" role="status">
          {status.diagnostic}
        </p>
      ) : null}
    </header>
  );
}

function describeSdk(status: SdkStatus | undefined): string {
  if (status === undefined) {
    return '⏳ detecting…';
  }
  return status.kind === 'ready' ? '🟢 detected' : '🔴 not detected';
}

function describeDebug(status: SdkStatus | undefined): string {
  if (status === undefined) {
    return '⏳ detecting…';
  }
  return status.kind === 'ready' ? '🟢 enabled' : '🔴 off';
}

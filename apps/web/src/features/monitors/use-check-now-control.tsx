import type { Monitor } from '@rain/shared';
import { Zap } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { useCheckNow } from './api';
import { CheckResult } from './checks';

function checkNowErrorText(error: Error): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CHECK_COOLDOWN':
      case 'CHECK_ALREADY_QUEUED':
      case 'MONITOR_PAUSED':
      case 'MONITOR_CONFIGURATION_INVALID':
      case 'RATE_LIMITED':
        return error.message;
    }
  }
  return `The check could not be run: ${error.message}`;
}

/** The Check Now button and what happened to the last click. */
export function useCheckNowControl(monitor: Monitor) {
  const checkNow = useCheckNow(monitor);
  const { state } = checkNow;
  const queued = state.phase === 'queued' || Boolean(monitor.manualCheckQueuedAt);

  const button = (
    <Button
      variant="outline"
      disabled={!monitor.enabled || checkNow.busy || queued}
      title={monitor.enabled ? undefined : 'Resume the monitor to run checks'}
      onClick={() => void checkNow.start()}
    >
      {checkNow.busy ? <Spinner label="Checking" /> : <Zap aria-hidden />}
      {state.phase === 'queued' ? 'Checking…' : 'Check now'}
    </Button>
  );

  const status =
    state.phase === 'queued' ? (
      <Alert variant="info">Check queued. Waiting for the monitoring worker to run it…</Alert>
    ) : state.phase === 'done' ? (
      <Alert variant={state.check.outcome === 'FAILURE' ? 'error' : 'success'}>
        <div className="grid gap-2">
          <p className="font-medium">Manual check finished</p>
          <CheckResult check={state.check} />
        </div>
      </Alert>
    ) : state.phase === 'timeout' ? (
      <Alert variant="error">
        The check is still queued. The monitoring worker may not be running; the result will appear
        in the history once it runs.
      </Alert>
    ) : state.phase === 'error' ? (
      <Alert variant="error">{checkNowErrorText(state.error)}</Alert>
    ) : null;

  return { button, status };
}

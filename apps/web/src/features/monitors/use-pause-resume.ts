import type { MonitorSummary } from '@rain/shared';
import { toast } from 'sonner';
import { useSetMonitorEnabled } from './api';

/**
 * Pause or resume, with feedback. The server keeps configuration and the last known status;
 * resuming schedules a check but records no result. One request at a time.
 */
export function usePauseResume() {
  const mutation = useSetMonitorEnabled();
  return {
    pendingId: mutation.isPending ? mutation.variables.id : undefined,
    toggle(monitor: Pick<MonitorSummary, 'id' | 'name' | 'enabled'>) {
      if (mutation.isPending) return;
      const enabled = !monitor.enabled;
      mutation.mutate(
        { id: monitor.id, enabled },
        {
          onSuccess: () =>
            toast.success(enabled ? `Resumed “${monitor.name}”` : `Paused “${monitor.name}”`, {
              description: enabled
                ? 'Checks are scheduled again. No result is recorded until a real check runs.'
                : 'No checks run while paused. Configuration and last known status are kept.',
            }),
        },
      );
    },
  };
}

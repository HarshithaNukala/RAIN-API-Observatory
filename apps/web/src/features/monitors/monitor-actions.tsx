import type { MonitorSummary } from '@rain/shared';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useDeleteMonitor } from './api';

type MonitorRef = Pick<MonitorSummary, 'id' | 'name'>;

export function DeleteMonitorDialog({
  monitor,
  onOpenChange,
  onDeleted,
}: {
  /** The monitor to confirm deletion for; null keeps the dialog closed. */
  monitor: MonitorRef | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const deletion = useDeleteMonitor();

  function close(open: boolean) {
    if (deletion.isPending) return;
    if (!open) deletion.reset();
    onOpenChange(open);
  }

  return (
    <AlertDialog open={monitor !== null} onOpenChange={close}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete monitor?</AlertDialogTitle>
        <AlertDialogDescription>
          <strong className="font-medium text-foreground">{monitor?.name}</strong> will be
          permanently deleted, together with its saved headers and request body. This can't be
          undone.
        </AlertDialogDescription>
        {deletion.isError && (
          <Alert variant="error">Couldn't delete the monitor: {deletion.error.message}</Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deletion.isPending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={deletion.isPending || !monitor}
            onClick={() => {
              if (!monitor) return;
              deletion.mutate(monitor.id, {
                onSuccess: () => {
                  toast.success(`Deleted “${monitor.name}”`);
                  deletion.reset();
                  onOpenChange(false);
                  onDeleted?.();
                },
              });
            }}
          >
            {deletion.isPending && <Spinner label="Deleting" />}
            Delete monitor
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

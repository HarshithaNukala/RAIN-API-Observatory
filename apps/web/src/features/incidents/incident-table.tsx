import type { Incident } from '@rain/shared';
import { Link } from 'react-router';
import { Table, Td, Th } from '@/components/ui/misc';
import { formatDateTime, formatRelative } from '@/features/monitors/format';
import { IncidentStatusBadge, SeverityBadge } from './badges';
import { formatDuration } from './format';

/** Incidents as a table: title, monitor, severity, status, start, duration, acknowledgement. */
export function IncidentTable({
  incidents,
  label = 'Incidents',
  showMonitor = true,
}: {
  incidents: Incident[];
  label?: string;
  showMonitor?: boolean;
}) {
  return (
    <Table aria-label={label}>
      <thead className="bg-muted/30">
        <tr>
          <Th>Incident</Th>
          {showMonitor && <Th className="hidden md:table-cell">Monitor</Th>}
          <Th className="hidden sm:table-cell">Severity</Th>
          <Th>Status</Th>
          <Th className="hidden xl:table-cell">Started</Th>
          <Th className="hidden sm:table-cell">Duration</Th>
          <Th className="hidden 2xl:table-cell">Acknowledged</Th>
        </tr>
      </thead>
      <tbody>
        {incidents.map((incident) => (
          <tr key={incident.id} className="border-t border-border hover:bg-accent/30">
            <Td className="w-full max-w-0 sm:w-auto sm:max-w-72">
              <Link
                to={`/app/incidents/${incident.id}`}
                className="block truncate font-medium hover:text-primary"
              >
                {incident.title}
              </Link>
              {showMonitor && (
                <span className="block truncate text-xs text-muted-foreground md:hidden">
                  {incident.monitor.name}
                </span>
              )}
            </Td>
            {showMonitor && (
              <Td className="hidden max-w-56 md:table-cell">
                <Link
                  to={`/app/monitors/${incident.monitor.id}`}
                  className="block truncate text-muted-foreground hover:text-primary"
                >
                  {incident.monitor.name}
                </Link>
              </Td>
            )}
            <Td className="hidden sm:table-cell">
              <SeverityBadge severity={incident.severity} />
            </Td>
            <Td>
              <IncidentStatusBadge status={incident.status} />
            </Td>
            <Td className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
              <time dateTime={incident.startedAt} title={formatDateTime(incident.startedAt)}>
                {formatRelative(incident.startedAt)}
              </time>
            </Td>
            <Td className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
              {formatDuration(incident.startedAt, incident.resolvedAt)}
              {!incident.resolvedAt && ' (ongoing)'}
            </Td>
            <Td className="hidden whitespace-nowrap text-muted-foreground 2xl:table-cell">
              {incident.acknowledgedAt ? (
                <time
                  dateTime={incident.acknowledgedAt}
                  title={formatDateTime(incident.acknowledgedAt)}
                >
                  {formatRelative(incident.acknowledgedAt)}
                </time>
              ) : (
                'Not acknowledged'
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

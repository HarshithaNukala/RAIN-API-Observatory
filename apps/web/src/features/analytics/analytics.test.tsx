// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  emptySeries,
  makeMonitorMetrics,
  makeOverview,
  withRecentBuckets,
} from '@/test-support/analytics-fixtures';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';
import { formatAvailability, formatLatency } from './format';

function seededOverview() {
  const fake = createFakeMonitorApi();
  const payments = fake.seed({ name: 'Payments', currentStatus: 'DOWN' });
  fake.seed({ name: 'Search', currentStatus: 'HEALTHY' });
  fake.analytics.overview['24h'] = makeOverview('24h', {
    monitors: { total: 5, healthy: 2, degraded: 1, down: 1, unknown: 0, paused: 1 },
    checks: {
      recorded: 1205,
      eligible: 1200,
      successful: 1188,
      failed: 12,
      slow: 30,
      excluded: 5,
      availabilityPercent: 99,
      failurePercent: 1,
    },
    latency: {
      samples: 1195,
      avgMs: 182.4,
      minMs: 41,
      maxMs: 2950,
      p50Ms: 150,
      p95Ms: 610.5,
      p99Ms: 1890,
    },
    series: withRecentBuckets(emptySeries('24h'), [
      {
        eligible: 60,
        successful: 58,
        failed: 2,
        availabilityPercent: 96.667,
        avgLatencyMs: 210,
        p95LatencyMs: 700,
        incidentsOpened: 1,
      },
      {
        eligible: 60,
        successful: 60,
        failed: 0,
        availabilityPercent: 100,
        avgLatencyMs: 160,
        p95LatencyMs: 400,
        incidentsResolved: 1,
      },
    ]),
    failureReasons: [
      { reason: 'TIMEOUT', count: 8, excludedFromAvailability: false },
      { reason: 'UNEXPECTED_STATUS', count: 4, excludedFromAvailability: false },
      { reason: 'BLOCKED_DESTINATION', count: 5, excludedFromAvailability: true },
    ],
    incidents: { opened: 3, resolved: 2, currentlyOpen: 1, averageResolutionMs: 754_000 },
    topFailingMonitors: [
      {
        monitor: { id: payments.id, name: 'Payments', currentStatus: 'DOWN', enabled: true },
        failed: 10,
        eligible: 300,
        availabilityPercent: 96.667,
      },
    ],
    topIncidentMonitors: [
      {
        monitor: { id: payments.id, name: 'Payments', currentStatus: 'DOWN', enabled: true },
        incidents: 3,
      },
    ],
  });
  return { fake, payments };
}

describe('formatters', () => {
  it('never rounds availability up to 100% and shows "No data" for null', () => {
    expect(formatAvailability(99.999)).toBe('99.99%');
    expect(formatAvailability(100)).toBe('100%');
    expect(formatAvailability(0)).toBe('0%');
    expect(formatAvailability(null)).toBe('No data');
  });

  it('formats latency in ms and seconds; null is "No data", never 0', () => {
    expect(formatLatency(87.4)).toBe('87 ms');
    expect(formatLatency(1240)).toBe('1.24 s');
    expect(formatLatency(null)).toBe('No data');
  });
});

describe('analytics dashboard', () => {
  it('shows summary cards, latency, failures, incidents and top monitors from the API', async () => {
    const { fake, payments } = seededOverview();
    renderApp('/app/analytics', fake);

    const summary = await screen.findByRole('region', { name: 'Summary' });
    expect(within(summary).getByLabelText('Monitors: 5')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Healthy: 2')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Degraded: 1')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Down: 1')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Availability: 99.00%')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Failed checks: 12')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Active incidents: 1')).toBeInTheDocument();

    expect(screen.getByLabelText('Average: 182 ms')).toBeInTheDocument();
    expect(screen.getByLabelText('P95: 611 ms')).toBeInTheDocument();
    expect(screen.getByLabelText('P99: 1.89 s')).toBeInTheDocument();

    const reasons = screen.getByRole('table', { name: 'Failure reasons' });
    const rows = within(reasons).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Timed out8'),
      expect.stringContaining('Unexpected status4'),
      expect.stringContaining('Destination not allowed (excluded from availability)5'),
    ]);

    expect(screen.getByLabelText('Average resolution time: 12m 34s')).toBeInTheDocument();
    const top = screen.getByRole('table', { name: 'Monitors with the most failures' });
    expect(within(top).getByRole('link', { name: 'Payments' })).toHaveAttribute(
      'href',
      `/app/monitors/${payments.id}`,
    );
  });

  it('draws the four charts with data and a table view; empty buckets read "No data"', async () => {
    const { fake } = seededOverview();
    const { user } = renderApp('/app/analytics', fake);
    for (const name of [
      'Availability history',
      'Response time',
      'Check activity',
      'Incident history',
    ]) {
      expect(await screen.findByRole('img', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('list', { name: 'Response time legend' })).toHaveTextContent(
      'AverageP95',
    );

    const table = screen.getByRole('table', { name: 'Availability history data' });
    await user.click(within(table.closest('details')!).getByText('Show data table'));
    const dataRows = within(table).getAllByRole('row').slice(1);
    expect(dataRows).toHaveLength(24);
    expect(dataRows[0]).toHaveTextContent('No data');
    expect(dataRows.at(-1)).toHaveTextContent('100%');
  });

  it('shows a tooltip for the hovered bucket', async () => {
    const { fake } = seededOverview();
    renderApp('/app/analytics', fake);
    const chart = await screen.findByRole('img', { name: 'Response time' });
    const hits = chart.querySelectorAll('[data-testid="chart-hit"]');
    fireEvent.mouseEnter(hits[hits.length - 2]!);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Average210 ms');
    expect(tooltip).toHaveTextContent('P95700 ms');
    fireEvent.mouseEnter(hits[0]!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('AverageNo data');
  });

  it('changes the range and requests it from the API', async () => {
    const { fake } = seededOverview();
    fake.analytics.overview['7d'] = makeOverview('7d', {
      monitors: { total: 5, healthy: 2, degraded: 1, down: 1, unknown: 0, paused: 1 },
      checks: {
        recorded: 8400,
        eligible: 8400,
        successful: 8358,
        failed: 42,
        slow: 0,
        excluded: 0,
        availabilityPercent: 99.5,
        failurePercent: 0.5,
      },
    });
    const { user, router } = renderApp('/app/analytics', fake);
    await screen.findByLabelText('Failed checks: 12');
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
    expect(await screen.findByLabelText('Failed checks: 42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(fake.requests.some((r) => r.path === '/api/v1/analytics/overview?range=7d')).toBe(true);
    expect(router.state.location.search).toBe('?range=7d');
    // 28 six-hour buckets in the table view.
    const table = screen.getByRole('table', { name: 'Check activity data' });
    expect(within(table).getAllByRole('row')).toHaveLength(29);
  });

  it('shows "No data" (not 0%) when monitors have no counted checks', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'New' });
    renderApp('/app/analytics', fake);
    expect(await screen.findByLabelText('Availability: No data')).toBeInTheDocument();
    expect(screen.getByText('No checks counted in this period')).toBeInTheDocument();
    expect(screen.getByText('No responses recorded in this period')).toBeInTheDocument();
    expect(screen.getByText('No incidents opened or resolved in this period')).toBeInTheDocument();
    expect(screen.getByLabelText('Average resolution time: No data')).toBeInTheDocument();
    // In the failure card and in the top-monitors card.
    expect(screen.getAllByText('No failed checks in this period.')).toHaveLength(2);
  });

  it('shows an empty state for a user with no monitors', async () => {
    renderApp('/app/analytics', createFakeMonitorApi());
    expect(await screen.findByRole('heading', { name: 'No monitors yet' })).toBeInTheDocument();
  });

  it('shows a loading state, then an error with retry', async () => {
    const { fake } = seededOverview();
    fake.latencyMs = 50;
    fake.failNext('GET', /^\/api\/v1\/analytics\/overview$/, 'network-error');
    const { user } = renderApp('/app/analytics', fake);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText("Couldn't load analytics")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeInTheDocument();
  });

  it('is in the main navigation', async () => {
    const { user } = renderApp('/app/monitors', createFakeMonitorApi());
    const nav = (await screen.findAllByRole('navigation', { name: 'Main' }))[0]!;
    await user.click(within(nav).getByRole('link', { name: 'Analytics' }));
    expect(await screen.findByRole('heading', { name: 'Analytics', level: 1 })).toBeInTheDocument();
  });
});

describe('monitor analytics tab', () => {
  it('shows health, availability, latency percentiles, counts and charts for the monitor', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments', currentStatus: 'DEGRADED' });
    const ref = { id: m.id, name: 'Payments', currentStatus: 'DEGRADED' as const, enabled: true };
    fake.analytics.metrics.set(m.id, {
      '24h': makeMonitorMetrics('24h', ref, {
        checks: {
          recorded: 100,
          eligible: 98,
          successful: 90,
          failed: 8,
          slow: 20,
          excluded: 2,
          availabilityPercent: 91.837,
          failurePercent: 8.163,
        },
        latency: {
          samples: 95,
          avgMs: 320,
          minMs: 50,
          maxMs: 4100,
          p50Ms: 210,
          p95Ms: 1500,
          p99Ms: 3900,
        },
        series: withRecentBuckets(emptySeries('24h'), [
          {
            eligible: 98,
            successful: 90,
            failed: 8,
            availabilityPercent: 91.837,
            avgLatencyMs: 320,
            p95LatencyMs: 1500,
          },
        ]),
      }),
      '30d': makeMonitorMetrics('30d', ref),
    });
    const { user } = renderApp(`/app/monitors/${m.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /analytics/i }));

    const summary = await screen.findByRole('region', { name: 'Monitor summary' });
    expect(within(summary).getAllByText('Degraded').length).toBeGreaterThan(0);
    expect(within(summary).getByLabelText('Availability: 91.83%')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Average response: 320 ms')).toBeInTheDocument();
    expect(within(summary).getByLabelText('P50: 210 ms')).toBeInTheDocument();
    expect(within(summary).getByLabelText('P95: 1.50 s')).toBeInTheDocument();
    expect(within(summary).getByLabelText('P99: 3.90 s')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Total checks: 100')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Failed checks: 8')).toBeInTheDocument();
    expect(within(summary).getByLabelText('Failure rate: 8.16%')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Availability history' })).toBeInTheDocument();
    expect(fake.requests.some((r) => r.path === `/api/v1/monitors/${m.id}/metrics?range=24h`)).toBe(
      true,
    );

    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Monitor summary' })).getByLabelText(
          'Availability: No data',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No checks were recorded for this monitor in this period/),
    ).toBeInTheDocument();
  });

  it('explains a paused monitor with no checks', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Paused', enabled: false });
    const { user } = renderApp(`/app/monitors/${m.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /analytics/i }));
    expect(await screen.findByText(/in this period \(it is paused\)/)).toBeInTheDocument();
  });

  it('shows an error with retry for the monitor metrics', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Payments' });
    fake.failNext('GET', /\/metrics$/, 'network-error');
    const { user } = renderApp(`/app/monitors/${m.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /analytics/i }));
    expect(await screen.findByText("Couldn't load analytics")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Monitor summary' })).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

afterEach(() => {
  vi.useRealTimers();
});

describe('registry health', () => {
  it('shows real health, last checked and next check from the API', async () => {
    const fake = createFakeMonitorApi();
    const now = Date.now();
    fake.seed({
      name: 'Checked',
      currentStatus: 'DOWN',
      lastCheckedAt: new Date(now - 5 * 60_000).toISOString(),
      nextCheckAt: new Date(now + 2 * 3600_000).toISOString(),
    });
    fake.seed({ name: 'Paused one', enabled: false, currentStatus: 'HEALTHY' });
    renderApp('/app/monitors', fake);

    const table = await screen.findByRole('table', { name: 'Monitors' });
    const checked = (await within(table).findByRole('link', { name: 'Checked' })).closest('tr')!;
    expect(within(checked).getAllByText('Down').length).toBeGreaterThan(0);
    expect(within(checked).getByText('5 minutes ago')).toBeInTheDocument();
    expect(within(checked).getByText('in 2 hours')).toBeInTheDocument();

    const paused = within(table).getByText('Paused one').closest('tr')!;
    expect(within(paused).getAllByText('Paused').length).toBeGreaterThan(0);
    expect(within(paused).getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(within(paused).getByText('—')).toBeInTheDocument();
  });
});

describe('monitor details: last check', () => {
  it('shows the last result with HTTP status, latency, error and the time since the status changed', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    fake.recordCheck(
      monitor.id,
      { outcome: 'SUCCESS', latencyMs: 87 },
      { currentStatus: 'HEALTHY' },
    );
    fake.recordCheck(
      monitor.id,
      {
        outcome: 'FAILURE',
        statusCode: 503,
        latencyMs: 41,
        failureReason: 'UNEXPECTED_STATUS',
        errorMessage: 'GET https://api.example.com/health: expected status 200, received 503',
      },
      { currentStatus: 'DEGRADED' },
    );
    renderApp(`/app/monitors/${monitor.id}`, fake);

    expect(await screen.findByText('HTTP 503')).toBeInTheDocument();
    expect(screen.getByText(/41 ms/)).toBeInTheDocument();
    expect(screen.getByText('Unexpected status')).toBeInTheDocument();
    expect(screen.getByText(/expected status 200, received 503/)).toBeInTheDocument();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0);
    expect(screen.getByText(/^Since/)).toBeInTheDocument();
  });

  it('shows "No response" and no latency for a check without an HTTP response', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    fake.recordCheck(monitor.id, {
      outcome: 'FAILURE',
      failureReason: 'TIMEOUT',
      errorMessage: 'no response within 10000 ms',
    });
    renderApp(`/app/monitors/${monitor.id}`, fake);
    expect(await screen.findByText('No response')).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    expect(screen.getByText(/· —/)).toBeInTheDocument();
  });
});

describe('Check Now', () => {
  it('queues through the API, waits for the worker and shows the real result', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);

    await user.click(await screen.findByRole('button', { name: /check now/i }));
    expect(await screen.findByText(/Check queued/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/check'))).toBe(true);

    // The worker runs the check.
    await waitFor(() => expect(fake.monitors.get(monitor.id)!.manualCheckQueuedAt).not.toBeNull());
    fake.completeManualCheck(
      monitor.id,
      { outcome: 'SUCCESS', statusCode: 204, latencyMs: 63 },
      { currentStatus: 'HEALTHY' },
    );

    expect(
      await screen.findByText('Manual check finished', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    const result = screen.getByText('Manual check finished').closest('[role="status"]')!;
    expect(within(result as HTMLElement).getByText('HTTP 204')).toBeInTheDocument();
    expect(within(result as HTMLElement).getByText(/63 ms/)).toBeInTheDocument();
    expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /check now/i })).toBeEnabled();
  });

  it('explains API refusals such as the cooldown', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    fake.failNext('POST', /\/check$/, {
      status: 429,
      body: {
        error: {
          code: 'CHECK_COOLDOWN',
          message: 'This monitor was checked manually moments ago. Try again in 7 s.',
          requestId: 'r1',
        },
      },
    });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('button', { name: /check now/i }));
    expect(await screen.findByText(/Try again in 7 s/)).toBeInTheDocument();
  });

  it('is disabled for paused monitors', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API', enabled: false });
    renderApp(`/app/monitors/${monitor.id}`, fake);
    expect(await screen.findByRole('button', { name: /check now/i })).toBeDisabled();
  });

  it('stops waiting after a bounded time and says the worker may be offline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('button', { name: /check now/i }));
    expect(await screen.findByText(/Check queued/)).toBeInTheDocument();
    const polls = () =>
      fake.requests.filter((r) => r.method === 'GET' && r.path === `/api/v1/monitors/${monitor.id}`)
        .length;
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await screen.findByText(/still queued/)).toBeInTheDocument();
    const after = polls();
    await vi.advanceTimersByTimeAsync(10_000);
    // Polling has stopped (only the page's own slow refresh may still run).
    expect(polls() - after).toBeLessThanOrEqual(1);
  });
});

describe('check history', () => {
  it('lists checks newest first, filters by source and loads older pages', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    for (let i = 0; i < 30; i++) {
      fake.recordCheck(monitor.id, {
        outcome: 'SUCCESS',
        latencyMs: i,
        source: i === 29 ? 'MANUAL' : 'SCHEDULED',
      });
    }
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /history/i }));

    const table = await screen.findByRole('table', { name: 'Check history' });
    const rows = () => within(table).getAllByRole('row').slice(1);
    expect(rows()).toHaveLength(25);
    expect(within(rows()[0]!).getByText('29 ms')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /load older checks/i }));
    await waitFor(() => expect(rows()).toHaveLength(30));
    expect(screen.queryByRole('button', { name: /load older checks/i })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter checks by source'), 'MANUAL');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Check history' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    expect(
      fake.requests.some((r) => r.path.includes('/checks?') && r.path.includes('source=MANUAL')),
    ).toBe(true);
  });

  it('shows an empty state when nothing has run', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    expect(await screen.findByRole('heading', { name: 'No checks yet' })).toBeInTheDocument();
  });

  it('shows an error with retry when history fails to load', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    fake.recordCheck(monitor.id, { outcome: 'SUCCESS' });
    // The overview's last-check card and the history tab each load once.
    fake.failNext('GET', /\/checks$/, 'network-error');
    fake.failNext('GET', /\/checks$/, 'network-error');
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    expect(await screen.findByText("Couldn't load the check history")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Check history' })).toBeInTheDocument();
  });

  it('shows a loading state while history loads', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    fake.latencyMs = 200;
    await user.selectOptions(screen.getByLabelText('Filter checks by source'), 'SCHEDULED');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByRole('heading', { name: 'No checks yet' })).toBeInTheDocument();
  });
});

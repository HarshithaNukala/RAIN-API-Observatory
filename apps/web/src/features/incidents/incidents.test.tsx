// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

function seedThree() {
  const fake = createFakeMonitorApi();
  const payments = fake.seed({ name: 'Payments', currentStatus: 'DOWN' });
  const search = fake.seed({ name: 'Search', currentStatus: 'HEALTHY' });
  const resolved = fake.seedIncident(search.id, {
    startedAt: '2026-11-17T08:00:00.000Z',
    resolvedAt: '2026-11-17T08:12:30.000Z',
    status: 'RESOLVED',
    severity: 'LOW',
  });
  const acked = fake.seedIncident(search.id, {
    startedAt: '2026-11-17T09:00:00.000Z',
    status: 'RESOLVED',
    resolvedAt: '2026-11-17T09:05:00.000Z',
  });
  const open = fake.seedIncident(payments.id, { severity: 'CRITICAL' });
  return { fake, payments, search, open, acked, resolved };
}

describe('incident dashboard', () => {
  it('shows counts and a list with monitor, severity, status, start, duration and acknowledgement', async () => {
    const { fake, open, resolved } = seedThree();
    renderApp('/app/incidents', fake);

    const counts = await screen.findByRole('region', { name: 'Incident counts' });
    await waitFor(() => expect(within(counts).getByLabelText('Total: 3')).toBeInTheDocument());
    expect(within(counts).getByLabelText('Open: 1')).toBeInTheDocument();
    expect(within(counts).getByLabelText('Acknowledged: 0')).toBeInTheDocument();
    expect(within(counts).getByLabelText('Resolved: 2')).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Incidents' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // Newest first.
    const first = rows[0]!;
    expect(within(first).getByRole('link', { name: open.title })).toHaveAttribute(
      'href',
      `/app/incidents/${open.id}`,
    );
    expect(within(first).getByRole('link', { name: 'Payments' })).toBeInTheDocument();
    expect(within(first).getByText('Critical')).toBeInTheDocument();
    expect(within(first).getByText('Open')).toBeInTheDocument();
    expect(within(first).getByText(/ongoing/)).toBeInTheDocument();
    expect(within(first).getByText('Not acknowledged')).toBeInTheDocument();
    const last = rows[2]!;
    expect(within(last).getByRole('link', { name: resolved.title })).toBeInTheDocument();
    expect(within(last).getByText('12m 30s')).toBeInTheDocument();
    expect(within(last).getByText('Resolved')).toBeInTheDocument();
  });

  it('filters by status and severity through the API', async () => {
    const { fake, open } = seedThree();
    const { user } = renderApp('/app/incidents', fake);
    await screen.findByRole('table', { name: 'Incidents' });

    await user.selectOptions(screen.getByLabelText('Filter by incident status'), 'ACTIVE');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Incidents' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    expect(screen.getByRole('link', { name: open.title })).toBeInTheDocument();
    expect(fake.requests.some((r) => r.path.includes('status=ACTIVE'))).toBe(true);

    await user.selectOptions(screen.getByLabelText('Filter by incident status'), '');
    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'LOW');
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Incidents' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
    expect(fake.requests.some((r) => r.path.includes('severity=LOW'))).toBe(true);

    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'MEDIUM');
    expect(
      await screen.findByRole('heading', { name: 'No matching incidents' }),
    ).toBeInTheDocument();
  });

  it('pages with "Load more"', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Flaky' });
    for (let i = 0; i < 25; i++) {
      fake.seedIncident(m.id, { status: 'RESOLVED', resolvedAt: '2026-11-18T00:00:00.000Z' });
    }
    const { user } = renderApp('/app/incidents', fake);
    const table = await screen.findByRole('table', { name: 'Incidents' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('Showing 20 of 25')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Showing 25 of 25')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an empty state with no incidents', async () => {
    renderApp('/app/incidents', createFakeMonitorApi());
    expect(await screen.findByRole('heading', { name: 'No incidents yet' })).toBeInTheDocument();
  });

  it('shows an error with retry, and a loading state', async () => {
    const { fake } = seedThree();
    fake.latencyMs = 50;
    fake.failNext('GET', /^\/api\/v1\/incidents$/, 'network-error');
    const { user } = renderApp('/app/incidents', fake);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText("Couldn't load incidents")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Incidents' })).toBeInTheDocument();
  });

  it('is reachable from the main navigation', async () => {
    const { user } = renderApp('/app/monitors', createFakeMonitorApi());
    const nav = (await screen.findAllByRole('navigation', { name: 'Main' }))[0]!;
    await user.click(within(nav).getByRole('link', { name: 'Incidents' }));
    expect(await screen.findByRole('heading', { name: 'Incidents', level: 1 })).toBeInTheDocument();
  });
});

describe('incident details', () => {
  it('shows facts, the monitor with its current health, and the timeline in order', async () => {
    const { fake, open, payments } = seedThree();
    renderApp(`/app/incidents/${open.id}`, fake);

    expect(await screen.findByRole('heading', { name: open.title, level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText(/Detected automatically after 2 consecutive failed checks/),
    ).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Not acknowledged')).toBeInTheDocument();
    expect(screen.getByText('Not resolved yet')).toBeInTheDocument();
    expect(screen.getAllByText('Down').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'View monitoring details' })).toHaveAttribute(
      'href',
      `/app/monitors/${payments.id}`,
    );
    const timeline = await screen.findByRole('list', { name: 'Incident timeline' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(1);
    expect(within(timeline).getByText('Incident opened')).toBeInTheDocument();
    expect(within(timeline).getByText(/by RAIN/)).toBeInTheDocument();
  });

  it('acknowledges an open incident and appends the event; the button disappears', async () => {
    const { fake, open } = seedThree();
    const { user } = renderApp(`/app/incidents/${open.id}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText('Acknowledged').length).toBeGreaterThan(0);
    const timeline = screen.getByRole('list', { name: 'Incident timeline' });
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(2));
    const items = within(timeline).getAllByRole('listitem');
    expect(within(items[0]!).getByText('Incident opened')).toBeInTheDocument();
    expect(within(items[1]!).getByText(/by you/)).toBeInTheDocument();
    expect(fake.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      `/api/v1/incidents/${open.id}/acknowledge`,
    ]);
  });

  it('shows the server refusal when acknowledgement is no longer possible', async () => {
    const { fake, open } = seedThree();
    fake.failNext('POST', /acknowledge$/, {
      status: 409,
      body: {
        error: {
          code: 'INCIDENT_ALREADY_RESOLVED',
          message: 'This incident is already resolved.',
          requestId: 'r',
        },
      },
    });
    const { user } = renderApp(`/app/incidents/${open.id}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('This incident is already resolved.')).toBeInTheDocument();
  });

  it('has no Acknowledge action for resolved incidents', async () => {
    const { fake, resolved } = seedThree();
    renderApp(`/app/incidents/${resolved.id}`, fake);
    await screen.findByRole('heading', { name: resolved.title, level: 1 });
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.getByText('Resolved', { selector: 'dt' })).toBeInTheDocument();
  });

  it('edits severity and title, recording an update event', async () => {
    const { fake, open } = seedThree();
    const { user } = renderApp(`/app/incidents/${open.id}`, fake);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Card payments failing');
    await user.selectOptions(screen.getByLabelText('Severity'), 'MEDIUM');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByRole('heading', { name: 'Card payments failing', level: 1 }),
    ).toBeInTheDocument();
    expect(fake.requests.find((r) => r.method === 'PATCH')!.body).toMatchObject({
      title: 'Card payments failing',
      severity: 'MEDIUM',
    });
    const timeline = screen.getByRole('list', { name: 'Incident timeline' });
    expect(
      await within(timeline).findByText(/Severity changed from CRITICAL to MEDIUM/),
    ).toBeInTheDocument();
  });

  it('shows "not found" for unknown incidents', async () => {
    renderApp('/app/incidents/00000000-0000-4000-8000-00000000dead', createFakeMonitorApi());
    expect(await screen.findByRole('heading', { name: 'Incident not found' })).toBeInTheDocument();
  });
});

describe('monitor details integration', () => {
  it('shows the active incident with a link, and recent history', async () => {
    const { fake, payments, open } = seedThree();
    fake.seedIncident(payments.id, {
      startedAt: '2026-11-10T08:00:00.000Z',
      status: 'RESOLVED',
      resolvedAt: '2026-11-10T09:00:00.000Z',
      title: 'Earlier outage',
    });
    renderApp(`/app/monitors/${payments.id}`, fake);
    expect(await screen.findByText(`Active incident: ${open.title}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View incident' })).toHaveAttribute(
      'href',
      `/app/incidents/${open.id}`,
    );
    const table = await screen.findByRole('table', { name: 'Monitor incidents' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('link', { name: 'Earlier outage' })).toBeInTheDocument();
  });

  it('shows no active incident when all are resolved', async () => {
    const { fake, search } = seedThree();
    renderApp(`/app/monitors/${search.id}`, fake);
    await screen.findByRole('table', { name: 'Monitor incidents' });
    expect(screen.queryByText(/Active incident/)).not.toBeInTheDocument();
  });

  it('says so when the monitor never had an incident', async () => {
    const fake = createFakeMonitorApi();
    const m = fake.seed({ name: 'Quiet' });
    renderApp(`/app/monitors/${m.id}`, fake);
    expect(await screen.findByText('No incidents for this monitor.')).toBeInTheDocument();
  });
});

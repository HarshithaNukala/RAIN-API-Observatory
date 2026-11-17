// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

const listRequests = (fake: ReturnType<typeof createFakeMonitorApi>) =>
  fake.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/monitors?'));

/**
 * The Status column cell of a row. Phones show the same badges under the name instead; jsdom
 * applies no CSS, so both copies exist here and assertions target the column cell.
 */
const statusCell = (row: HTMLElement) => within(row.querySelectorAll('td')[3]!);

describe('monitor registry', () => {
  it('lists monitors from the API with stored status, paused state and no invented data', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Payments API', url: 'https://pay.example.com/health', method: 'GET' });
    fake.seed({
      name: 'Search API',
      url: 'https://search.example.com/ping',
      method: 'POST',
      enabled: false,
      currentStatus: 'DOWN',
      checkIntervalSeconds: 60,
    });
    renderApp('/app/monitors', fake);

    await screen.findByRole('link', { name: 'Payments API' });
    const table = screen.getByRole('table', { name: 'Monitors' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    const search = within(rows[0]!);
    expect(search.getByRole('link', { name: 'Search API' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/app\/monitors\/.+/),
    );
    expect(statusCell(rows[0]!).getByText('Paused')).toBeInTheDocument();
    expect(statusCell(rows[0]!).getByText('Down')).toBeInTheDocument();
    expect(search.getByText('POST')).toBeInTheDocument();
    expect(search.getByText('Every 1 minute')).toBeInTheDocument();

    const payments = within(rows[1]!);
    expect(statusCell(rows[1]!).getByText('Unknown')).toBeInTheDocument();
    expect(payments.queryByText('Paused')).not.toBeInTheDocument();
    expect(payments.getByText('Never')).toBeInTheDocument();
    expect(screen.getByText('2 of 25 monitors used')).toBeInTheDocument();
  });

  it('searches by name after typing pauses', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Payments API' });
    fake.seed({ name: 'Search API' });
    const { user } = renderApp('/app/monitors', fake);
    await screen.findByRole('link', { name: 'Payments API' });

    await user.type(screen.getByRole('searchbox', { name: /search monitors/i }), 'pay');

    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Search API' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Payments API' })).toBeInTheDocument();
    expect(listRequests(fake).at(-1)?.path).toContain('search=pay');
    // Debounced: not one request per keystroke.
    expect(listRequests(fake).filter((r) => r.path.includes('search='))).toHaveLength(1);
  });

  it('filters by stored status and by paused state', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Healthy one', currentStatus: 'HEALTHY' });
    fake.seed({ name: 'Down one', currentStatus: 'DOWN' });
    fake.seed({ name: 'Paused one', enabled: false });
    const { user } = renderApp('/app/monitors', fake);
    await screen.findByRole('link', { name: 'Healthy one' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'DOWN');
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Healthy one' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Down one' })).toBeInTheDocument();
    expect(listRequests(fake).at(-1)?.path).toContain('status=DOWN');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by state' }), 'paused');
    await waitFor(() => expect(listRequests(fake).at(-1)?.path).toContain('state=paused'));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Down one' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: 'Paused one' })).toBeInTheDocument();
  });

  it('pages through results with cursors and shows the range', async () => {
    const fake = createFakeMonitorApi();
    for (let i = 1; i <= 25; i++) fake.seed({ name: `Monitor ${String(i).padStart(2, '0')}` });
    const { user } = renderApp('/app/monitors', fake);

    expect(await screen.findByText('Showing 1–20 of 25')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    // Newest first.
    expect(screen.getByRole('link', { name: 'Monitor 25' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('Showing 21–25 of 25')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Monitor 01' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Monitor 25' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(listRequests(fake).at(-1)?.path).toContain('cursor=');

    await user.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('Showing 1–20 of 25')).toBeInTheDocument();
  });

  it('shows an empty state with a call to action when there are no monitors', async () => {
    renderApp('/app/monitors');
    expect(await screen.findByRole('heading', { name: 'No monitors yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add your first monitor/i })).toHaveAttribute(
      'href',
      '/app/monitors/new',
    );
  });

  it('distinguishes "no matches" from "no monitors" and clears filters', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Payments API' });
    const { user } = renderApp('/app/monitors?status=DOWN', fake);
    expect(
      await screen.findByRole('heading', { name: 'No monitors match these filters' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('link', { name: 'Payments API' })).toBeInTheDocument();
  });

  it('shows the API error with a working retry', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Payments API' });
    fake.failNext('GET', /^\/api\/v1\/monitors$/, {
      status: 503,
      body: {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable', requestId: 'r-9' },
      },
    });
    const { user } = renderApp('/app/monitors', fake);

    expect(await screen.findByText("Couldn't load monitors")).toBeInTheDocument();
    expect(screen.getByText('Database unavailable')).toBeInTheDocument();
    expect(screen.getByText('Request ID: r-9')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Payments API' })).toBeInTheDocument();
  });

  it('disables Add monitor when the quota is used up', async () => {
    const fake = createFakeMonitorApi({ quotaLimit: 1 });
    fake.seed({ name: 'Only one' });
    renderApp('/app/monitors', fake);
    await screen.findByText('1 of 1 monitors used');
    expect(screen.getByRole('button', { name: /add monitor/i })).toBeDisabled();
  });

  it('pauses and resumes from the row actions', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API', currentStatus: 'HEALTHY' });
    const { user } = renderApp('/app/monitors', fake);
    await screen.findByRole('link', { name: 'Payments API' });

    await user.click(screen.getByRole('button', { name: 'Actions for Payments API' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }));
    const row = () => screen.getByRole('link', { name: 'Payments API' }).closest('tr')!;
    expect(await statusCell(row()).findByText('Paused')).toBeInTheDocument();
    // Pausing keeps the last stored status visible: nothing is invented or reset.
    expect(statusCell(row()).getByText('Healthy')).toBeInTheDocument();
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ method: 'POST', path: `/api/v1/monitors/${monitor.id}/pause` }),
    );

    await user.click(screen.getByRole('button', { name: 'Actions for Payments API' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resume' }));
    await waitFor(() => expect(statusCell(row()).queryByText('Paused')).not.toBeInTheDocument());
    expect(statusCell(row()).getByText('Healthy')).toBeInTheDocument();
  });

  it('deletes only after confirming in a dialog that names the monitor', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    fake.seed({ name: 'Search API' });
    const { user } = renderApp('/app/monitors', fake);
    await screen.findByRole('link', { name: 'Payments API' });

    const openDialog = async () => {
      await user.click(screen.getByRole('button', { name: 'Actions for Payments API' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      return screen.findByRole('alertdialog');
    };

    let dialog = await openDialog();
    expect(within(dialog).getByText('Payments API')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fake.requests.some((r) => r.method === 'DELETE')).toBe(false);

    dialog = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Delete monitor' }));
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Payments API' })).not.toBeInTheDocument(),
    );
    expect(fake.requests).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: `/api/v1/monitors/${monitor.id}` }),
    );
    expect(screen.getByRole('link', { name: 'Search API' })).toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when deletion fails', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'Payments API' });
    fake.failNext('DELETE', /^\/api\/v1\/monitors\/.+$/, {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    });
    const { user } = renderApp('/app/monitors', fake);
    await screen.findByRole('link', { name: 'Payments API' });

    await user.click(screen.getByRole('button', { name: 'Actions for Payments API' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete monitor' }));

    expect(
      await within(dialog).findByText(/Couldn't delete the monitor: Internal server error/),
    ).toBeInTheDocument();
    expect(fake.monitors.size).toBe(1);
  });
});

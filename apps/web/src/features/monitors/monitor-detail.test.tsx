// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

const SECRET = 'Bearer detail-secret-777';

describe('monitor details', () => {
  it('shows configuration and header names but no credential values or invented history', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({
      name: 'Payments API',
      description: 'Card payments',
      url: 'https://pay.example.com/health',
      method: 'POST',
      expectedStatusCode: 201,
      timeoutMs: 5000,
      latencyThresholdMs: 800,
      checkIntervalSeconds: 600,
      requestBody: '{"secret":"in-body"}',
      bodyContentType: 'application/json',
      headers: [{ name: 'Authorization', value: SECRET, updatedAt: '2026-11-16T09:00:00.000Z' }],
    });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);

    expect(await screen.findByRole('heading', { name: 'Payments API' })).toBeInTheDocument();
    expect(screen.getByText('Card payments')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No check history yet' })).toBeInTheDocument();
    expect(screen.queryByText(/uptime \d/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /configuration/i }));
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('201')).toBeInTheDocument();
    expect(within(panel).getByText('5,000 ms')).toBeInTheDocument();
    expect(within(panel).getByText('800 ms')).toBeInTheDocument();
    expect(within(panel).getByText('Every 10 minutes')).toBeInTheDocument();
    expect(within(panel).getByText('Authorization')).toBeInTheDocument();
    expect(within(panel).getByText('Credential configured')).toBeInTheDocument();
    expect(within(panel).getByText(/Configured · 20 B · application\/json/)).toBeInTheDocument();
    // Neither header values nor the body content are shown on this page.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain('in-body');
  });

  it('pauses and resumes, keeping the stored status and disabling the button meanwhile', async () => {
    const fake = createFakeMonitorApi();
    fake.latencyMs = 30;
    const monitor = fake.seed({ name: 'Payments API', currentStatus: 'DEGRADED' });
    const { user } = renderApp(`/app/monitors/${monitor.id}`, fake);

    const pause = await screen.findByRole('button', { name: 'Pause' });
    await user.click(pause);
    expect(pause).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByText(/This monitor is paused/)).toBeInTheDocument();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0);
    expect(screen.getByText('None while paused')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.queryByText(/This monitor is paused/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0);
    expect(fake.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      `/api/v1/monitors/${monitor.id}/pause`,
      `/api/v1/monitors/${monitor.id}/resume`,
    ]);
  });

  it('deletes after confirmation and returns to the registry', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    const { user, router } = renderApp(`/app/monitors/${monitor.id}`, fake);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Payments API')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete monitor' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/app/monitors'));
    expect(await screen.findByRole('heading', { name: 'No monitors yet' })).toBeInTheDocument();
    expect(fake.monitors.size).toBe(0);
  });

  it('shows "Monitor not found" for an unknown or foreign monitor', async () => {
    renderApp('/app/monitors/00000000-0000-4000-8000-999999999999');
    expect(await screen.findByRole('heading', { name: 'Monitor not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to monitors' })).toHaveAttribute(
      'href',
      '/app/monitors',
    );
  });
});

describe('application shell', () => {
  it('has only working navigation entries and breadcrumbs', async () => {
    const fake = createFakeMonitorApi();
    const monitor = fake.seed({ name: 'Payments API' });
    renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    await screen.findByLabelText('Name');
    const nav = screen.getAllByRole('navigation', { name: 'Main' })[0]!;
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Monitors']);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Monitors' })).toHaveAttribute(
      'href',
      '/app/monitors',
    );
    expect(within(crumbs).getByRole('link', { name: 'Payments API' })).toHaveAttribute(
      'href',
      `/app/monitors/${monitor.id}`,
    );
  });

  it('opens the mobile navigation and closes it after navigating', async () => {
    const { user, router } = renderApp('/app');
    await user.click(await screen.findByRole('button', { name: 'Open navigation' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('link', { name: 'Monitors' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/app/monitors');
  });

  it('signs out from the profile menu', async () => {
    const { user, signOut } = renderApp('/app');
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('tester@example.com')).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /sign out/i }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('redirects / to the overview and shows the real monitor count there', async () => {
    const fake = createFakeMonitorApi();
    fake.seed({ name: 'One' });
    const { router } = renderApp('/', fake);
    expect(await screen.findByText(/1 of 25 monitors configured/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/app');
  });
});

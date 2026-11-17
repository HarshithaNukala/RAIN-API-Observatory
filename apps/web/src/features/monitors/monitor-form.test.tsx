// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeMonitorApi, type FakeMonitorApi } from '@/test-support/fake-monitor-api';
import { renderApp } from '@/test-support/render-app';

const SECRET = 'Bearer live-secret-abc123';
const writes = (fake: FakeMonitorApi) => fake.requests.filter((r) => r.method !== 'GET');

describe('create monitor', () => {
  it('shows validation errors beside their fields and sends nothing', async () => {
    const fake = createFakeMonitorApi();
    const { user } = renderApp('/app/monitors/new', fake);

    await user.type(await screen.findByLabelText('URL'), 'http://10.0.0.5/health');
    await user.clear(screen.getByLabelText('Latency threshold (ms)'));
    await user.type(screen.getByLabelText('Latency threshold (ms)'), '20000');
    await user.clear(screen.getByLabelText('Timeout (ms)'));
    await user.type(screen.getByLabelText('Timeout (ms)'), '5000');
    await user.click(screen.getByRole('button', { name: 'Create monitor' }));

    expect(await screen.findByText('Some fields need attention.')).toBeInTheDocument();
    // Focus moves to the first invalid field, which may be far above the submit button.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Enter a name');
    expect(screen.getByLabelText('URL')).toHaveAccessibleDescription(
      /Private, loopback and reserved/,
    );
    expect(screen.getByLabelText('Latency threshold (ms)')).toHaveAccessibleDescription(
      /must not be longer than the timeout/,
    );
    expect(writes(fake)).toHaveLength(0);
  });

  it('explains the standard-port rule before submitting', async () => {
    const fake = createFakeMonitorApi();
    const { user } = renderApp('/app/monitors/new', fake);
    await user.type(await screen.findByLabelText('Name'), 'Custom port');
    await user.type(screen.getByLabelText('URL'), 'https://api.example.com:8443/health');
    await user.click(screen.getByRole('button', { name: 'Create monitor' }));

    expect(screen.getByLabelText('URL')).toHaveAccessibleDescription(
      /80 for http:\/\/ and 443 for https:\/\//,
    );
    expect(writes(fake)).toHaveLength(0);
  });

  it('creates a monitor with an encrypted-at-rest header and opens its page', async () => {
    const fake = createFakeMonitorApi();
    const { user, router } = renderApp('/app/monitors/new', fake);

    await user.type(await screen.findByLabelText('Name'), 'Payments API');
    await user.type(screen.getByLabelText('URL'), 'https://pay.example.com/health');
    await user.selectOptions(screen.getByLabelText('HTTP method'), 'POST');
    await user.type(screen.getByLabelText('Body'), '{{"ping":true}');
    await user.click(screen.getByRole('button', { name: /add header/i }));
    await user.type(screen.getByLabelText('Header name'), 'Authorization');
    const value = screen.getByLabelText('Value for Authorization');
    expect(value).toHaveAttribute('type', 'password');
    await user.type(value, SECRET);
    await user.click(screen.getByRole('button', { name: 'Show Value for Authorization' }));
    expect(value).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Create monitor' }));

    expect(await screen.findByRole('heading', { name: 'Payments API' })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/app\/monitors\/[^/]+$/);
    expect(writes(fake)).toEqual([
      {
        method: 'POST',
        path: '/api/v1/monitors',
        body: expect.objectContaining({
          name: 'Payments API',
          url: 'https://pay.example.com/health',
          method: 'POST',
          requestBody: '{"ping":true}',
          headers: [{ name: 'Authorization', value: SECRET }],
        }),
      },
    ]);
    // The new page shows that a credential exists, never what it is.
    await user.click(screen.getByRole('tab', { name: /configuration/i }));
    expect(await screen.findByText('Credential configured')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('prevents duplicate submission while saving', async () => {
    const fake = createFakeMonitorApi();
    fake.latencyMs = 50;
    const { user } = renderApp('/app/monitors/new', fake);
    await user.type(await screen.findByLabelText('Name'), 'Once');
    await user.type(screen.getByLabelText('URL'), 'https://once.example.com/');
    const submit = screen.getByRole('button', { name: 'Create monitor' });
    await user.click(submit);
    expect(submit).toBeDisabled();
    await user.click(submit);
    await screen.findByRole('heading', { name: 'Once' });
    expect(writes(fake)).toHaveLength(1);
  });

  it('shows API errors that the form could not predict', async () => {
    const fake = createFakeMonitorApi();
    fake.failNext('POST', /^\/api\/v1\/monitors$/, {
      status: 409,
      body: { error: { code: 'MONITOR_LIMIT_REACHED', message: "You've reached the limit." } },
    });
    const { user } = renderApp('/app/monitors/new', fake);
    await user.type(await screen.findByLabelText('Name'), 'Over quota');
    await user.type(screen.getByLabelText('URL'), 'https://quota.example.com/');
    await user.click(screen.getByRole('button', { name: 'Create monitor' }));
    expect(await screen.findByText("You've reached the limit.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create monitor' })).toBeEnabled();
  });
});

function seedWithSecrets(fake: FakeMonitorApi) {
  return fake.seed({
    name: 'Payments API',
    url: 'https://pay.example.com/health',
    method: 'POST',
    requestBody: '{"amount":1}',
    bodyContentType: 'application/json',
    headers: [
      { name: 'Authorization', value: SECRET, updatedAt: '2026-11-16T09:00:00.000Z' },
      { name: 'X-Tenant', value: 'acme', updatedAt: '2026-11-16T09:00:00.000Z' },
    ],
  });
}

describe('edit monitor', () => {
  it('loads settings and shows stored credentials as configured, never their values', async () => {
    const fake = createFakeMonitorApi();
    const monitor = seedWithSecrets(fake);
    renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    expect(await screen.findByLabelText('Name')).toHaveValue('Payments API');
    expect(screen.getByLabelText('URL')).toHaveValue('https://pay.example.com/health');
    expect(screen.getAllByText('Credential configured')).toHaveLength(2);
    const replacement = screen.getByLabelText('New value for Authorization');
    expect(replacement).toHaveValue('');
    expect(replacement).toHaveAttribute('type', 'password');
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('keeps a stored credential when its value field is left empty', async () => {
    const fake = createFakeMonitorApi();
    const monitor = seedWithSecrets(fake);
    const { user } = renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Payments API v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('heading', { name: 'Payments API v2' })).toBeInTheDocument();
    // Only the changed setting was sent, and no header request at all.
    expect(writes(fake)).toEqual([
      {
        method: 'PATCH',
        path: `/api/v1/monitors/${monitor.id}`,
        body: { name: 'Payments API v2' },
      },
    ]);
    expect(fake.monitors.get(monitor.id)?.headers.map((h) => h.value)).toEqual([SECRET, 'acme']);
  });

  it('replaces a credential only when a new value is typed', async () => {
    const fake = createFakeMonitorApi();
    const monitor = seedWithSecrets(fake);
    const { user } = renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    await user.type(await screen.findByLabelText('New value for X-Tenant'), 'globex');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByRole('heading', { name: 'Payments API' });
    expect(writes(fake)).toEqual([
      {
        method: 'PATCH',
        path: `/api/v1/monitors/${monitor.id}/headers`,
        body: { upsert: [{ name: 'X-Tenant', value: 'globex' }], remove: [] },
      },
    ]);
    expect(
      fake.monitors.get(monitor.id)?.headers.find((h) => h.name === 'Authorization')?.value,
    ).toBe(SECRET);
  });

  it('deletes a stored credential only through an explicit Remove', async () => {
    const fake = createFakeMonitorApi();
    const monitor = seedWithSecrets(fake);
    const { user } = renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Authorization' }));
    expect(screen.getByText('Will be removed when you save.')).toBeInTheDocument();
    // Undo is possible before saving.
    await user.click(screen.getByRole('button', { name: 'Keep Authorization' }));
    await user.click(screen.getByRole('button', { name: 'Remove Authorization' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByRole('heading', { name: 'Payments API' });
    expect(writes(fake)).toEqual([
      {
        method: 'PATCH',
        path: `/api/v1/monitors/${monitor.id}/headers`,
        body: { upsert: [], remove: ['Authorization'] },
      },
    ]);
    expect(fake.monitors.get(monitor.id)?.headers.map((h) => h.name)).toEqual(['X-Tenant']);
  });

  it('saves a same-origin path change without asking and keeps credentials', async () => {
    const fake = createFakeMonitorApi();
    const monitor = seedWithSecrets(fake);
    const { user } = renderApp(`/app/monitors/${monitor.id}/edit`, fake);

    const url = await screen.findByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'https://pay.example.com/v2/health?region=eu');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByRole('heading', { name: 'Payments API' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(fake.monitors.get(monitor.id)?.headers).toHaveLength(2);
  });

  describe('origin change', () => {
    async function changeHost() {
      const fake = createFakeMonitorApi();
      const monitor = seedWithSecrets(fake);
      const rendered = renderApp(`/app/monitors/${monitor.id}/edit`, fake);
      const url = await screen.findByLabelText('URL');
      await rendered.user.clear(url);
      await rendered.user.type(url, 'https://other-api.example.org/health');
      await rendered.user.click(screen.getByRole('button', { name: 'Save changes' }));
      return { ...rendered, fake, monitor };
    }

    it('asks for confirmation before sending anything', async () => {
      const { fake } = await changeHost();
      const dialog = await screen.findByRole('alertdialog');
      expect(
        within(dialog).getByText(
          'Changing this destination will remove saved authentication headers and the request body. You will need to enter them again for the new destination.',
        ),
      ).toBeInTheDocument();
      expect(writes(fake)).toHaveLength(0);
    });

    it('on cancel sends nothing and restores the saved URL', async () => {
      const { fake, user } = await changeHost();
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.getByLabelText('URL')).toHaveValue('https://pay.example.com/health');
      expect(writes(fake)).toHaveLength(0);
      expect(fake.monitors.get(fake.monitors.keys().next().value!)?.headers).toHaveLength(2);
    });

    it('on confirm sends confirmOriginChange, clears credentials and lets new ones be entered', async () => {
      const { fake, user, monitor } = await changeHost();
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Change destination' }));

      expect(
        await screen.findByText(/saved authentication headers and request body were removed/),
      ).toBeInTheDocument();
      expect(writes(fake)).toEqual([
        {
          method: 'PATCH',
          path: `/api/v1/monitors/${monitor.id}`,
          body: { url: 'https://other-api.example.org/health', confirmOriginChange: true },
        },
      ]);
      const stored = fake.monitors.get(monitor.id);
      expect(stored).toMatchObject({ headers: [], requestBody: null, bodyContentType: null });

      // The form now reflects the server: no saved headers, empty body, new URL.
      expect(screen.queryByText('Credential configured')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Body')).toHaveValue('');
      expect(screen.getByLabelText('URL')).toHaveValue('https://other-api.example.org/health');

      await user.click(screen.getByRole('button', { name: /add header/i }));
      await user.type(screen.getByLabelText('Header name'), 'Authorization');
      await user.type(screen.getByLabelText('Value for Authorization'), 'Bearer for-new-host');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await screen.findByRole('heading', { name: 'Payments API' });
      expect(fake.monitors.get(monitor.id)?.headers.map((h) => h.value)).toEqual([
        'Bearer for-new-host',
      ]);
    });

    it('opens the confirmation when the server requires it, even if the form did not expect it', async () => {
      const fake = createFakeMonitorApi();
      // The form sees no saved secrets, but the server reports some (e.g. added in another tab).
      const monitor = fake.seed({ name: 'Race', url: 'https://pay.example.com/' });
      fake.failNext('PATCH', /^\/api\/v1\/monitors\/[^/]+$/, {
        status: 409,
        body: {
          error: {
            code: 'MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED',
            message: 'Confirmation required',
          },
        },
      });
      const { user } = renderApp(`/app/monitors/${monitor.id}/edit`, fake);
      const url = await screen.findByLabelText('URL');
      await user.clear(url);
      await user.type(url, 'https://elsewhere.example.org/');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Change destination' }));
      await screen.findByRole('heading', { name: 'Race' });
      expect(writes(fake).at(-1)?.body).toEqual({
        url: 'https://elsewhere.example.org/',
        confirmOriginChange: true,
      });
    });
  });
});

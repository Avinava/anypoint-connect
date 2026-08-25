import { describe, expect, it } from 'vitest';
import { renderOAuthCallbackPage } from '../../src/auth/OAuthCallbackPage.js';

describe('OAuthCallbackPage', () => {
    it('renders a responsive success page without external assets or scripts', () => {
        const html = renderOAuthCallbackPage({
            status: 'success',
            title: 'Authentication successful',
            message: 'Return to the terminal.',
        });

        expect(html).toContain('<!doctype html>');
        expect(html).toContain('name="viewport"');
        expect(html).toContain('Authentication successful');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('https://');
    });

    it('escapes every dynamic field in an error page', () => {
        const html = renderOAuthCallbackPage({
            status: 'error',
            title: '<title>',
            message: '"message" & more',
            detail: "<script>'unsafe'</script>",
        });

        expect(html).toContain('&lt;title&gt;');
        expect(html).toContain('&quot;message&quot; &amp; more');
        expect(html).toContain('&lt;script&gt;&#39;unsafe&#39;&lt;/script&gt;');
        expect(html).not.toContain("<script>'unsafe'</script>");
    });
});

/**
 * Self-contained HTML shown by the local OAuth callback server.
 *
 * The page intentionally has no external assets or JavaScript: it must render
 * reliably while authentication is in progress and must never leak callback
 * parameters to another origin.
 */

export type OAuthCallbackPageStatus = 'success' | 'error';

export interface OAuthCallbackPageOptions {
    status: OAuthCallbackPageStatus;
    title: string;
    message: string;
    detail?: string;
}

export const OAUTH_CALLBACK_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
} as const;

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (character) => {
        const entities: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;',
        };
        return entities[character];
    });
}

export function renderOAuthCallbackPage(options: OAuthCallbackPageOptions): string {
    const isSuccess = options.status === 'success';
    const statusLabel = isSuccess ? 'Connected' : 'Authentication interrupted';
    const safeTitle = escapeHtml(options.title);
    const safeMessage = escapeHtml(options.message);
    const safeDetail = options.detail ? escapeHtml(options.detail) : '';

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${safeTitle} · Anypoint Connect</title>
    <style>
        :root {
            color-scheme: light dark;
            --paper: #f5f7fa;
            --surface: #ffffff;
            --ink: #172033;
            --muted: #536078;
            --rule: rgba(23, 32, 51, 0.14);
            --accent: #087ea4;
            --accent-soft: rgba(8, 126, 164, 0.10);
            --danger: #a63d4b;
            --danger-soft: rgba(166, 61, 75, 0.10);
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --paper: #111621;
                --surface: #192131;
                --ink: #f2f5fa;
                --muted: #a9b4c7;
                --rule: rgba(242, 245, 250, 0.14);
                --accent: #57c7e8;
                --accent-soft: rgba(87, 199, 232, 0.12);
                --danger: #ff929f;
                --danger-soft: rgba(255, 146, 159, 0.12);
            }
        }

        * { box-sizing: border-box; }

        body {
            min-height: 100vh;
            margin: 0;
            display: grid;
            place-items: center;
            padding: 24px;
            background: var(--paper);
            color: var(--ink);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.55;
            -webkit-font-smoothing: antialiased;
        }

        main {
            width: min(100%, 560px);
            padding: clamp(28px, 7vw, 48px);
            background: var(--surface);
            border: 1px solid var(--rule);
            border-radius: 16px;
        }

        .mark {
            width: 52px;
            height: 52px;
            display: grid;
            place-items: center;
            margin-bottom: 24px;
            border-radius: 12px;
            background: ${isSuccess ? 'var(--accent-soft)' : 'var(--danger-soft)'};
            color: ${isSuccess ? 'var(--accent)' : 'var(--danger)'};
            font-size: 28px;
            font-weight: 700;
        }

        .eyebrow {
            margin: 0 0 10px;
            color: ${isSuccess ? 'var(--accent)' : 'var(--danger)'};
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        h1 {
            margin: 0 0 14px;
            font-size: clamp(28px, 7vw, 40px);
            line-height: 1.12;
            letter-spacing: -0.025em;
        }

        p { margin: 0; color: var(--muted); }

        .detail {
            margin-top: 22px;
            padding: 14px 16px;
            overflow-wrap: anywhere;
            background: ${isSuccess ? 'var(--accent-soft)' : 'var(--danger-soft)'};
            border-left: 3px solid ${isSuccess ? 'var(--accent)' : 'var(--danger)'};
            border-radius: 6px;
            color: var(--ink);
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 13px;
        }

        .next {
            margin-top: 28px;
            padding-top: 20px;
            border-top: 1px solid var(--rule);
            font-size: 14px;
        }
    </style>
</head>
<body>
    <main aria-labelledby="page-title">
        <div class="mark" aria-hidden="true">${isSuccess ? '✓' : '!'}</div>
        <p class="eyebrow">${statusLabel}</p>
        <h1 id="page-title">${safeTitle}</h1>
        <p>${safeMessage}</p>
        ${safeDetail ? `<div class="detail" role="alert">${safeDetail}</div>` : ''}
        <p class="next">You can close this tab and return to the terminal.</p>
    </main>
</body>
</html>`;
}

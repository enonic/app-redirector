import type { Request, Response } from '@enonic-types/core';
import { getContent, getSite } from '/lib/xp/portal';
import { getBaseUrlFromSite, findMatchInRules, traceRedirects } from '../../../lib/redirector';

interface RuleSource {
    exact?: { path: string };
    prefix?: { path: string };
    regex?: { expression: string };
}

const STYLES = `
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f9fafb; color: #111827; }
    .card { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .step { padding: 12px; margin-bottom: 8px; border-left: 4px solid #3b82f6; background: #eff6ff; }
    .step.error { border-color: #ef4444; background: #fef2f2; }
    .step.success { border-color: #10b981; background: #ecfdf5; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: bold; background: #e5e7eb; margin-right: 8px; }
    h1 { margin-top: 0; }
    .loop-warning { color: #dc2626; font-weight: bold; margin-top: 20px; padding: 16px; background: #fef2f2; border: 1px solid #f87171; border-radius: 4px; }
    .test-form { margin-bottom: 24px; }
    .test-form input[type="text"] { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; width: 300px; }
    .test-form button { padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; margin-left: 8px; }
    .test-form button:hover { background: #2563eb; }
    .form-note { font-size: 13px; color: #6b7280; margin-top: 6px; }
    .form-row { margin-bottom: 16px; }
    .no-match { color: #6b7280; font-style: italic; margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 4px; }
`;

function getDefaultPath(source: RuleSource | undefined): string {
    if (source && source.exact && source.exact.path) return source.exact.path;
    if (source && source.prefix && source.prefix.path) return source.prefix.path;
    if (source && source.regex && source.regex.expression) {
        // Extract literal prefix from regex: strip leading ^ and take characters before first special char
        let expr = source.regex.expression;
        if (expr.charAt(0) === '^') expr = expr.substring(1);
        const match = expr.match(/^(\/[^(.[{\\*+?|$]*)/);
        if (match) return match[1];
    }
    return '';
}

function getSourceHint(source: RuleSource | undefined): string {
    if (source && source.exact) return 'Auto-filled from exact match path.';
    if (source && source.prefix) return 'Auto-filled from prefix path. Try appending a suffix, e.g. ' + (source.prefix.path || '') + '/something';
    if (source && source.regex) return 'Regex rule: ' + source.regex.expression + ' &mdash; enter a path that matches.';
    return '';
}

function renderForm(sourcePath: string, baseUrl: string, autoResolved: boolean, sourceHint: string): string {
    return `
        <div class="test-form">
            <form method="GET">
                <div class="form-row">
                    <label><strong>Source path to test:</strong> <span style="color: #dc2626;">*</span></label><br/>
                    <input type="text" name="sourcePath" value="${sourcePath}" placeholder="/old-page" required />
                    <button type="submit">Trace</button>
                    <div class="form-note">${sourceHint}</div>
                </div>
                <div class="form-row">
                    <label><strong>Base URL:</strong> <span style="color: #9ca3af;">(optional)</span></label><br/>
                    <input type="text" name="baseUrl" value="${baseUrl}" placeholder="https://example.com" />
                    <div class="form-note">
                        ${autoResolved ? 'Auto-resolved from site config. ' : ''}Used for display only &mdash; trace works without it.
                    </div>
                </div>
            </form>
        </div>
    `;
}

export function get(req: Request): Response {
    const ruleContent = getContent();

    if (!ruleContent) {
        return { body: '<h1>Error: No content found.</h1>', contentType: 'text/html' };
    }

    // Try to auto-resolve baseUrl from site config
    let baseUrl = '';
    let autoResolved = false;
    const site = getSite();
    if (site) {
        const resolved = getBaseUrlFromSite(site._id);
        if (resolved) {
            baseUrl = resolved;
            autoResolved = true;
        }
    }

    const params = req.params || {};
    if (params.baseUrl) {
        baseUrl = params.baseUrl as string;
    }

    const source = (ruleContent.data as Record<string, unknown>).source as RuleSource | undefined;
    const defaultPath = getDefaultPath(source);
    const sourceHint = getSourceHint(source);
    const sourcePath = (params.sourcePath as string) || defaultPath;

    const heading = `
        <h1>Rule Tester</h1>
        <p style="font-size: 15px; color: #6b7280; margin-top: -8px;">${ruleContent.displayName || ruleContent._name}</p>
    `;

    // Source path is required to run a test
    if (!sourcePath) {
        return {
            body: `<html><head><style>${STYLES}</style></head><body>
                <div class="card">
                    ${heading}
                    ${renderForm('', baseUrl, autoResolved, sourceHint)}
                </div>
            </body></html>`,
            contentType: 'text/html'
        };
    }

    const firstMatch = findMatchInRules(sourcePath, [ruleContent]);

    if (!firstMatch) {
        return {
            body: `<html><head><style>${STYLES}</style></head><body>
                <div class="card">
                    ${heading}
                    ${renderForm(sourcePath, baseUrl, autoResolved, sourceHint)}
                    <div class="no-match">Path "${sourcePath}" did not match this rule.</div>
                </div>
            </body></html>`,
            contentType: 'text/html'
        };
    }

    const ruleSetPath = (ruleContent as unknown as { _parentPath: string })._parentPath;
    const trace = traceRedirects(sourcePath, firstMatch, ruleSetPath, baseUrl);

    const htmlBody = `
        <html>
        <head><style>${STYLES}</style></head>
        <body>
            <div class="card">
                ${heading}
                ${renderForm(sourcePath, baseUrl, autoResolved, sourceHint)}

                <hr style="margin: 24px 0; border: none; border-top: 1px solid #e5e7eb;" />

                <h3>Execution Trace:</h3>
                ${trace.steps.map((step, index) => `
                    <div class="step ${step.statusCode >= 400 ? 'error' : (index === trace.steps.length - 1 ? 'success' : '')}">
                        <span class="badge">${step.statusCode}</span>
                        <strong>${step.url}</strong>
                        <div style="font-size: 13px; color: #6b7280; margin-top: 4px;">
                            ${step.isExternal ? 'External Hop' : 'Internal Hop'} &mdash; ${step.note}
                        </div>
                    </div>
                `).join('')}

                ${trace.loopDetected ? `
                    <div class="loop-warning">
                        Infinite Loop or Max Hops (10) Detected! Please fix your routing configuration.
                    </div>
                ` : `
                    <div style="margin-top: 20px; color: #059669; font-weight: bold;">
                        Trace completed successfully.
                    </div>
                `}
            </div>
        </body>
        </html>
    `;

    return {
        body: htmlBody,
        contentType: 'text/html'
    };
}

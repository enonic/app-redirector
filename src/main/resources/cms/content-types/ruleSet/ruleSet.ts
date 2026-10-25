import type { Request, Response } from '@enonic-types/core';
import { getContent, getSite } from '/lib/xp/portal';
import { getBaseUrlFromSite, findMatchInRuleSet, traceRedirects } from '../../../lib/redirector';

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

function renderForm(baseUrl: string, sourcePath: string, autoResolved: boolean): string {
    return `
        <div class="test-form">
            <form method="GET">
                <div class="form-row">
                    <label><strong>Source path to test:</strong> <span style="color: #dc2626;">*</span></label><br/>
                    <input type="text" name="sourcePath" value="${sourcePath}" placeholder="/old-page" required />
                    <button type="submit">Test</button>
                    <div class="form-note">
                        Examples: /old-page, /blog/2024/my-post, /products/shoes
                    </div>
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
    const ruleSetContent = getContent();

    if (!ruleSetContent) {
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

    // Read query parameters
    const params = req.params || {};
    if (params.baseUrl) {
        baseUrl = params.baseUrl as string;
    }
    const sourcePath = (params.sourcePath as string) || '';

    const heading = `
        <h1>RuleSet Tester</h1>
        <p style="font-size: 15px; color: #6b7280; margin-top: -8px;">${ruleSetContent.displayName || ruleSetContent._name}</p>
    `;

    // Source path is required to run a test
    if (!sourcePath) {
        return {
            body: `<html><head><style>${STYLES}</style></head><body>
                <div class="card">
                    ${heading}
                    ${renderForm(baseUrl, sourcePath, autoResolved)}
                </div>
            </body></html>`,
            contentType: 'text/html'
        };
    }

    // Find a matching rule in this ruleSet
    const ruleSetPath = ruleSetContent._path;
    const match = findMatchInRuleSet(sourcePath, ruleSetPath);

    if (!match) {
        return {
            body: `<html><head><style>${STYLES}</style></head><body>
                <div class="card">
                    ${heading}
                    ${renderForm(baseUrl, sourcePath, autoResolved)}
                    <div class="no-match">No rules matched the path "${sourcePath}" in this RuleSet.</div>
                </div>
            </body></html>`,
            contentType: 'text/html'
        };
    }

    // Trace the redirect chain
    const trace = traceRedirects(sourcePath, match, ruleSetPath, baseUrl);

    const htmlBody = `
        <html>
        <head><style>${STYLES}</style></head>
        <body>
            <div class="card">
                ${heading}
                ${renderForm(baseUrl, sourcePath, autoResolved)}

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

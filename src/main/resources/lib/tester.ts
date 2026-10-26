import type { Content } from '@enonic-types/core';
import { getBaseUrlFromSite, findMatchInRules, findMatchInRuleSet, traceRedirects, type TraceResult } from './redirector';

export interface TesterParams {
    sourcePath?: string;
    baseUrl?: string;
}

export interface TesterContext {
    content: Content;
    siteId?: string;
    action: string;
    hiddenFields: Record<string, string>;
    params: TesterParams;
}

export interface TesterResult {
    body: string;
    messages: string[];
}

interface RuleSource {
    exact?: { path: string };
    prefix?: { path: string };
    regex?: { expression: string };
}

const STYLES = `
    body { font-family: system-ui, sans-serif; padding: 40px; background: #f9fafb; color: #111827; margin: 0; }
    .card { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .step { padding: 12px; margin-bottom: 8px; border-left: 4px solid #3b82f6; background: #eff6ff; }
    .step.error { border-color: #ef4444; background: #fef2f2; }
    .step.success { border-color: #10b981; background: #ecfdf5; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: bold; background: #e5e7eb; margin-right: 8px; }
    h1 { margin-top: 0; }
    .subtitle { font-size: 15px; color: #6b7280; margin-top: -8px; }
    .loop-warning { color: #dc2626; font-weight: bold; margin-top: 20px; padding: 16px; background: #fef2f2; border: 1px solid #f87171; border-radius: 4px; }
    .success-note { margin-top: 20px; color: #059669; font-weight: bold; }
    .test-form { margin-bottom: 24px; }
    .test-form input[type="text"] { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; width: 300px; }
    .test-form button { padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; margin-left: 8px; }
    .test-form button:hover { background: #2563eb; }
    .form-note { font-size: 13px; color: #6b7280; margin-top: 6px; }
    .form-row { margin-bottom: 16px; }
    .required { color: #dc2626; }
    .optional { color: #9ca3af; }
    .no-match { color: #6b7280; font-style: italic; margin-top: 16px; padding: 16px; background: #f3f4f6; border-radius: 4px; }
    hr { margin: 24px 0; border: none; border-top: 1px solid #e5e7eb; }
`;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function page(inner: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLES}</style></head><body><div class="card">${inner}</div></body></html>`;
}

function heading(title: string, content: Content): string {
    return `<h1>${title}</h1><p class="subtitle">${escapeHtml(content.displayName || content._name)}</p>`;
}

function renderForm(ctx: TesterContext, sourcePath: string, baseUrl: string, autoResolved: boolean, hint: string, buttonLabel: string): string {
    const hidden = Object.keys(ctx.hiddenFields)
        .map((name) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(ctx.hiddenFields[name])}" />`)
        .join('');
    return `
        <div class="test-form">
            <form method="GET" action="${escapeHtml(ctx.action)}">
                ${hidden}
                <div class="form-row">
                    <label><strong>Source path to test:</strong> <span class="required">*</span></label><br/>
                    <input type="text" name="sourcePath" value="${escapeHtml(sourcePath)}" placeholder="/old-page" required />
                    <button type="submit">${buttonLabel}</button>
                    <div class="form-note">${hint}</div>
                </div>
                <div class="form-row">
                    <label><strong>Base URL:</strong> <span class="optional">(optional)</span></label><br/>
                    <input type="text" name="baseUrl" value="${escapeHtml(baseUrl)}" placeholder="https://example.com" />
                    <div class="form-note">${autoResolved ? 'Auto-resolved from site config. ' : ''}Used for display only &mdash; trace works without it.</div>
                </div>
            </form>
        </div>`;
}

function renderTrace(trace: TraceResult): string {
    const steps = trace.steps.map((step, index) => {
        const cls = step.statusCode >= 400 ? 'error' : (index === trace.steps.length - 1 ? 'success' : '');
        return `
            <div class="step ${cls}">
                <span class="badge">${step.statusCode}</span>
                <strong>${escapeHtml(step.url)}</strong>
                <div class="form-note">${step.isExternal ? 'External Hop' : 'Internal Hop'} &mdash; ${escapeHtml(step.note || '')}</div>
            </div>`;
    }).join('');
    const verdict = trace.loopDetected
        ? '<div class="loop-warning">Infinite Loop or Max Hops (10) Detected! Please fix your routing configuration.</div>'
        : '<div class="success-note">Trace completed successfully.</div>';
    return `<hr/><h3>Execution Trace:</h3>${steps}${verdict}`;
}

function resolveBaseUrl(ctx: TesterContext): { baseUrl: string; autoResolved: boolean } {
    let baseUrl = '';
    let autoResolved = false;
    if (ctx.siteId) {
        const resolved = getBaseUrlFromSite(ctx.siteId);
        if (resolved) {
            baseUrl = resolved;
            autoResolved = true;
        }
    }
    if (ctx.params.baseUrl) {
        baseUrl = ctx.params.baseUrl;
    }
    return { baseUrl, autoResolved };
}

function getDefaultPath(source: RuleSource | undefined): string {
    if (source?.exact?.path) return source.exact.path;
    if (source?.prefix?.path) return source.prefix.path;
    if (source?.regex?.expression) {
        let expr = source.regex.expression;
        if (expr.charAt(0) === '^') expr = expr.substring(1);
        const match = expr.match(/^(\/[^(.[{\\*+?|$]*)/);
        if (match) return match[1];
    }
    return '';
}

function getSourceHint(source: RuleSource | undefined): string {
    if (source?.exact) return 'Auto-filled from exact match path.';
    if (source?.prefix) return 'Auto-filled from prefix path. Try appending a suffix, e.g. ' + escapeHtml(source.prefix.path || '') + '/something';
    if (source?.regex) return 'Regex rule: ' + escapeHtml(source.regex.expression) + ' &mdash; enter a path that matches.';
    return '';
}

export function renderRuleTester(ctx: TesterContext): TesterResult {
    const rule = ctx.content;
    const { baseUrl, autoResolved } = resolveBaseUrl(ctx);
    const source = (rule.data as Record<string, unknown>).source as RuleSource | undefined;
    const sourcePath = ctx.params.sourcePath || getDefaultPath(source);
    const hint = getSourceHint(source);
    const head = heading('Rule Tester', rule);
    const form = renderForm(ctx, sourcePath, baseUrl, autoResolved, hint, 'Trace');

    if (!sourcePath) {
        return { body: page(head + form), messages: [] };
    }

    const match = findMatchInRules(sourcePath, [rule]);
    if (!match) {
        return {
            body: page(`${head}${form}<div class="no-match">Path "${escapeHtml(sourcePath)}" did not match this rule.</div>`),
            messages: [],
        };
    }

    const ruleSetPath = rule._path.substring(0, rule._path.lastIndexOf('/'));
    const trace = traceRedirects(sourcePath, match, ruleSetPath, baseUrl);
    return {
        body: page(head + form + renderTrace(trace)),
        messages: trace.loopDetected ? ['Redirect loop or max hop count detected'] : [],
    };
}

export function renderRuleSetTester(ctx: TesterContext): TesterResult {
    const ruleSet = ctx.content;
    const { baseUrl, autoResolved } = resolveBaseUrl(ctx);
    const sourcePath = ctx.params.sourcePath || '';
    const head = heading('RuleSet Tester', ruleSet);
    const form = renderForm(ctx, sourcePath, baseUrl, autoResolved, 'Examples: /old-page, /blog/2024/my-post, /products/shoes', 'Test');

    if (!sourcePath) {
        return { body: page(head + form), messages: [] };
    }

    const match = findMatchInRuleSet(sourcePath, ruleSet._path);
    if (!match) {
        return {
            body: page(`${head}${form}<div class="no-match">No rules matched the path "${escapeHtml(sourcePath)}" in this RuleSet.</div>`),
            messages: [],
        };
    }

    const trace = traceRedirects(sourcePath, match, ruleSet._path, baseUrl);
    return {
        body: page(head + form + renderTrace(trace)),
        messages: trace.loopDetected ? ['Redirect loop or max hop count detected'] : [],
    };
}

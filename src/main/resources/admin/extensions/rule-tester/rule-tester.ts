import type { Request, Response } from '@enonic-types/core';
import { get as getContent, getSite } from '/lib/xp/content';
import { run } from '/lib/xp/context';
import { renderRuleTester, renderRuleSetTester, type TesterResult } from '../../../lib/tester';

const RULE_TYPE = `${app.name}:rule`;
const RULE_SET_TYPE = `${app.name}:ruleSet`;
const PASSTHROUGH_PARAMS = ['contentId', 'contentPath', 'type', 'repo', 'branch', 'mode', 'archive'];

const SECURITY_HEADERS = {
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'",
};

function param(req: Request, name: string): string {
    const value = req.params[name];
    return Array.isArray(value) ? value[0] : (value || '');
}

function supports(type: string): boolean {
    return type === RULE_TYPE || type === RULE_SET_TYPE;
}

export function HEAD(req: Request): Response {
    return { status: supports(param(req, 'type')) ? 200 : 418 };
}

export function GET(req: Request): Response {
    const type = param(req, 'type');
    if (!supports(type)) {
        return { status: 418 };
    }

    const contentId = param(req, 'contentId');
    const repository = param(req, 'repo');
    const branch = param(req, 'branch') || 'draft';

    const result = run({ repository, branch }, (): TesterResult | null => {
        const content = getContent({ key: contentId });
        if (!content) {
            return null;
        }
        const site = getSite({ key: contentId });
        const hiddenFields: Record<string, string> = {};
        PASSTHROUGH_PARAMS.forEach((name) => {
            const value = param(req, name);
            if (value) hiddenFields[name] = value;
        });
        const ctx = {
            content,
            siteId: site ? site._id : undefined,
            action: req.contextPath || '',
            hiddenFields,
            params: {
                sourcePath: param(req, 'sourcePath'),
                baseUrl: param(req, 'baseUrl'),
            },
        };
        return type === RULE_TYPE ? renderRuleTester(ctx) : renderRuleSetTester(ctx);
    });

    if (!result) {
        return { status: 404 };
    }

    return {
        status: 200,
        contentType: 'text/html',
        headers: {
            ...SECURITY_HEADERS,
            'enonic-widget-data': JSON.stringify({ messages: result.messages }),
        },
        body: result.body,
    };
}

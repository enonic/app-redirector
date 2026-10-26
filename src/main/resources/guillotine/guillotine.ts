import type { Content } from '@enonic-types/core';
import { query, getSite, get as getContent } from '/lib/xp/content';
import { findMatchInRules } from '../lib/redirector';

/* eslint-disable @typescript-eslint/no-explicit-any -- Guillotine extension API is untyped */
export const extensions = (graphQL: any) => {
    return {
        types: {
            RedirectResult: {
                description: 'The matched redirect rule and its target. Exactly one of external, path and content is set. The incoming query string is not part of the result; forward it in the client.',
                fields: {
                    statusCode: { type: graphQL.nonNull(graphQL.GraphQLInt), description: 'HTTP status code to respond with (301, 302 or 410)' },
                    external: { type: graphQL.GraphQLString, description: 'Absolute URL, for external targets' },
                    path: { type: graphQL.GraphQLString, description: 'Relative path with $n placeholders substituted, for path targets' },
                    content: { type: graphQL.reference('Content'), description: 'Target content, for content targets. Build its URL with pageUrl { path baseUrl }' },
                    rule: { type: graphQL.reference('Content'), description: 'The rule that matched' },
                    url: { type: graphQL.GraphQLString, description: 'Legacy: the external URL, the path, or the content path, with the incoming query string appended' }
                }
            }
        },
        creationCallbacks: {
            HeadlessCms: (params: any) => {
                params.addFields({
                    redirect: {
                        type: graphQL.reference('RedirectResult'),
                        description: 'Evaluates a request path against the redirect rules of the selected scope. Returns null when no rule matches.',
                        args: {
                            path: graphQL.nonNull(graphQL.GraphQLString),
                            ruleSet: graphQL.GraphQLString
                        }
                    }
                });
            }
        },
        resolvers: {
            HeadlessCms: {
                redirect: (env: any) => {
                    try {
                        return resolveRedirect(env);
                    } catch (e) {
                        log.warning('Redirector: redirect lookup failed, returning null', e);
                        return null;
                    }
                }
            }
        }
    };
};

interface RedirectResult {
    statusCode: number;
    external?: string;
    path?: string;
    content?: Content;
    rule?: Content;
    url: string;
}

function resolveRedirect(env: any): RedirectResult | null {
    const rawPath = env.args.path as string;
    const qIndex = rawPath.indexOf('?');
    const requestPath = qIndex >= 0 ? rawPath.substring(0, qIndex) : rawPath;
    const queryString = qIndex >= 0 ? rawPath.substring(qIndex) : '';
    let ruleSetIdOrPath = env.args.ruleSet;

    // 1. AUTO-DISCOVERY: If no ruleSet is explicitly provided by the frontend
    if (!ruleSetIdOrPath) {
        // Guillotine 9 exposes the selected scope (site or other content) as localContext.scopeKey
        const scopeKey = env.localContext?.scopeKey;
        const site = scopeKey && scopeKey !== '/' ? getSite({ key: scopeKey }) : null;

        if (site) {
            ruleSetIdOrPath = `${site._path}/_redirects`;
        } else {
            ruleSetIdOrPath = '/_redirects';
        }
    }

    // 2. FETCH THE RULESET (Validate it exists and is the correct type)
    let ruleSet = getContent({ key: ruleSetIdOrPath });

    // Fall back to project root if site-level ruleSet not found
    if ((!ruleSet || ruleSet.type !== 'com.enonic.app.redirector:ruleSet') && ruleSetIdOrPath !== '/_redirects') {
        ruleSet = getContent({ key: '/_redirects' });
    }

    if (!ruleSet || ruleSet.type !== 'com.enonic.app.redirector:ruleSet') {
        return null;
    }

    // 3. FETCH THE RULES
    const parentPath = '/content' + ruleSet._path;
    const rulesResult = query({
        count: 1000,
        filters: {
            boolean: {
                must: [
                    { hasValue: { field: '_parentPath', values: [parentPath] } },
                    { hasValue: { field: 'type', values: ['com.enonic.app.redirector:rule'] } }
                ]
            }
        },
        sort: '_manualOrderValue DESC'
    });

    if (rulesResult.total === 0) {
        return null;
    }

    // 4. EVALUATE MATCHES
    const match = findMatchInRules(requestPath, rulesResult.hits);

    if (!match) {
        return null;
    }

    // 5. RESOLVE TARGET
    const rule = rulesResult.hits.filter((hit: Content) => hit._id === match.ruleId)[0];
    const result: RedirectResult = { statusCode: match.statusCode || 301, rule, url: '' };
    if (match.target.external?.url) {
        result.external = match.target.external.url;
        result.url = result.external;
    } else if (match.target.relative?.path) {
        result.path = match.target.relative.path;
        result.url = result.path;
    } else if (match.target.reference?.content) {
        const targetContent = getContent({ key: match.target.reference.content });
        if (targetContent) {
            result.content = targetContent;
            // Legacy url: the content path with non-ASCII segments percent-encoded
            result.url = targetContent._path.split('/').map(encodeURIComponent).join('/');
        }
    }

    if (!result.url) {
        return null;
    }

    // Legacy url keeps the incoming query string; the structured fields do not
    if (queryString) {
        result.url += (result.url.indexOf('?') >= 0 ? '&' + queryString.substring(1) : queryString);
    }

    log.debug('Redirector: %s %s -> %s (rule %s)', result.statusCode, requestPath, result.url, match.ruleId);

    return result;
}

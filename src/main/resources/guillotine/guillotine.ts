import { query, getSite, get as getContent } from '/lib/xp/content';
import { findMatchInRules } from '../lib/redirector';

/* eslint-disable @typescript-eslint/no-explicit-any -- Guillotine extension API is untyped */
export const extensions = (graphQL: any) => {
    return {
        types: {
            RedirectResult: {
                description: 'The resolved target and status code for a matched redirect',
                fields: {
                    url: { type: graphQL.GraphQLString },
                    statusCode: { type: graphQL.GraphQLInt }
                }
            }
        },
        creationCallbacks: {
            HeadlessCms: (params: any) => {
                params.addFields({
                    redirect: {
                        type: graphQL.reference('RedirectResult'),
                        description: 'Evaluates the provided path against the project redirect rules.',
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

function resolveRedirect(env: any): { url: string; statusCode: number } | null {
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

    // 5. RESOLVE TARGET URL
    let finalUrl = '';
    if (match.target.external?.url) {
        finalUrl = match.target.external.url;
    } else if (match.target.relative?.path) {
        finalUrl = match.target.relative.path;
    } else if (match.target.reference?.content) {
        const targetContent = getContent({ key: match.target.reference.content });
        if (targetContent) {
            // Encode non-ASCII characters in system-resolved paths, preserving path separators
            finalUrl = targetContent._path.split('/').map(encodeURIComponent).join('/');
        }
    }

    // Append original query string to target
    if (finalUrl && queryString) {
        const hasQuery = finalUrl.indexOf('?') >= 0;
        finalUrl = finalUrl + (hasQuery ? '&' + queryString.substring(1) : queryString);
    }

    if (!finalUrl) {
        return null;
    }

    log.debug('Redirector: %s %s -> %s (rule %s)', match.statusCode, requestPath, finalUrl, match.ruleId);

    return {
        url: finalUrl,
        statusCode: match.statusCode || 301
    };
}

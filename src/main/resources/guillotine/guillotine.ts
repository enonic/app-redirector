import { query, getSite, get as getContent } from '/lib/xp/content';
import { findMatchInRules } from '../lib/redirector';

/* eslint-disable @typescript-eslint/no-explicit-any -- Guillotine extension API is untyped */
export const extensions = (graphQL: any) => {
    log.info('Redirector: Guillotine extension loaded');
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
                log.info('Redirector: creationCallbacks.HeadlessCms called');
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
                    const rawPath = env.args.path as string;
                    const qIndex = rawPath.indexOf('?');
                    const requestPath = qIndex >= 0 ? rawPath.substring(0, qIndex) : rawPath;
                    const queryString = qIndex >= 0 ? rawPath.substring(qIndex) : '';
                    let ruleSetIdOrPath = env.args.ruleSet;

                    log.info('Redirector: Resolve called with path "%s", ruleSet arg: %s', requestPath, ruleSetIdOrPath || '(none)');
                    log.info('Redirector: env.localContext: %s', env.localContext);
                    log.info('Redirector: env.localContext.siteKey: %s', env.localContext?.siteKey);

                    // 1. AUTO-DISCOVERY: If no ruleSet is explicitly provided by the frontend
                    if (!ruleSetIdOrPath) {
                        const siteKey = env.localContext?.siteKey;
                        const site = siteKey ? getSite({ key: siteKey }) : null;

                        if (site) {
                            ruleSetIdOrPath = `${site._path}/_redirects`;
                            log.info('Redirector: Auto-discovered site "%s", trying "%s"', site._path, ruleSetIdOrPath);
                        } else {
                            ruleSetIdOrPath = '/_redirects';
                            log.info('Redirector: No site context, falling back to "/_redirects"');
                        }
                    }

                    // 2. FETCH THE RULESET (Validate it exists and is the correct type)
                    let ruleSet = getContent({ key: ruleSetIdOrPath });
                    log.info('Redirector: Fetched ruleSet at "%s" — found: %s, type: %s', ruleSetIdOrPath, !!ruleSet, ruleSet ? ruleSet.type : '(null)');

                    // Fall back to project root if site-level ruleSet not found
                    if ((!ruleSet || ruleSet.type !== 'com.enonic.app.redirector:ruleSet') && ruleSetIdOrPath !== '/_redirects') {
                        log.info('Redirector: Site-level ruleSet not valid, falling back to "/_redirects"');
                        ruleSet = getContent({ key: '/_redirects' });
                        log.info('Redirector: Fallback ruleSet — found: %s, type: %s', !!ruleSet, ruleSet ? ruleSet.type : '(null)');
                    }

                    if (!ruleSet || ruleSet.type !== 'com.enonic.app.redirector:ruleSet') {
                        log.info('Redirector: No valid ruleSet found, returning null');
                        return null;
                    }

                    // 3. FETCH THE RULES
                    // Debug: query children without type filter first
                    const debugResult = query({
                        count: 10,
                        filters: {
                            boolean: {
                                must: [
                                    { hasValue: { field: '_parentPath', values: [ruleSet._path] } }
                                ]
                            }
                        }
                    });
                    log.info('Redirector: DEBUG children of "%s": total=%s, types=%s',
                        ruleSet._path,
                        debugResult.total,
                        debugResult.hits.map((h: any) => h.type).join(', ')
                    );

                    // Debug: also try with /content prefix
                    const debugResult2 = query({
                        count: 10,
                        filters: {
                            boolean: {
                                must: [
                                    { hasValue: { field: '_parentPath', values: ['/content' + ruleSet._path] } }
                                ]
                            }
                        }
                    });
                    log.info('Redirector: DEBUG children of "/content%s": total=%s, types=%s',
                        ruleSet._path,
                        debugResult2.total,
                        debugResult2.hits.map((h: any) => h.type).join(', ')
                    );

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

                    log.info('Redirector: Processing %s rules from ruleSet "%s" for path "%s"', rulesResult.total, ruleSet._path, requestPath);
                    rulesResult.hits.forEach((h: any, i: number) => {
                        log.info('Redirector:   [%s] %s — %s (manualOrderValue: %s)', i, h._name, h.type, h.data?.manualOrderValue);
                    });

                    if (rulesResult.total === 0) {
                        return null;
                    }

                    // 4. EVALUATE MATCHES
                    const match = findMatchInRules(requestPath, rulesResult.hits);

                    if (!match) {
                        log.info('Redirector: No matching rule found for path "%s"', requestPath);
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
                        log.info('Redirector: Rule "%s" matched but target could not be resolved', match.ruleId);
                        return null;
                    }

                    log.info('Redirector: Matched rule "%s" — %s %s -> %s', match.ruleId, match.statusCode, requestPath, finalUrl);

                    return {
                        url: finalUrl,
                        statusCode: match.statusCode || 301
                    };
                }
            }
        }
    };
};

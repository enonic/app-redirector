import { get, query, getSite } from '/lib/xp/content';
import { request, type HttpResponse } from '/lib/http-client';

export interface TraceStep {
    url: string;
    statusCode: number;
    isExternal: boolean;
    note?: string;
}

export interface TraceResult {
    steps: TraceStep[];
    loopDetected: boolean;
    finalUrl: string;
}

/**
 * Resolves the baseUrl strictly from the site's portal app config.
 */
export function getBaseUrlFromSite(siteId: string): string | null {
    const site = getSite({ key: siteId });
    if (!site || !site.data || !site.data.siteConfig) {
        return null;
    }

    const configs = Array.isArray(site.data.siteConfig) 
        ? site.data.siteConfig 
        : [site.data.siteConfig];

    let portalConfig: Record<string, unknown> | null = null;
    for (let j = 0; j < configs.length; j++) {
        const cfg = configs[j] as unknown as Record<string, unknown>;
        if (cfg.applicationKey === 'portal') {
            portalConfig = cfg;
            break;
        }
    }
    const config = portalConfig ? portalConfig.config as Record<string, unknown> : null;
    return config && config.baseUrl ? config.baseUrl as string : null;
}

export interface MatchResult {
    ruleId: string;
    statusCode: number;
    isExternal: boolean;
    target: {
        reference?: { content: string };
        relative?: { path: string };
        external?: { url: string };
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- XP content objects are loosely typed
export function findMatchInRules(requestPath: string, rules: any[]): MatchResult | null {
    if (!requestPath || !rules) {
        return null;
    }

    for (const rule of rules) {
        const source = rule.data?.source;
        if (!source) continue;

        let matched = false;
        let captures: string[] = [];

        if (source.exact) {
            if (source.exact.path && requestPath === source.exact.path) {
                matched = true;
            }
        } else if (source.prefix) {
            if (source.prefix.path && requestPath.indexOf(source.prefix.path) === 0) {
                matched = true;
                captures = [requestPath.substring(source.prefix.path.length)];
            }
        } else if (source.regex) {
            if (source.regex.expression) {
                try {
                    const re = new RegExp(source.regex.expression);
                    const result = requestPath.match(re);
                    if (result) {
                        matched = true;
                        captures = result.slice(1);
                    }
                } catch {
                    continue;
                }
            }
        }

        if (!matched) continue;

        const target = rule.data?.target;
        if (!target) continue;

        const statusCode = parseInt(rule.data?.statusCode, 10) || 301;
        const isExternal = !!target.external;

        const resolvedTarget: MatchResult['target'] = {};
        if (target.reference) {
            resolvedTarget.reference = { content: target.reference.content };
        } else if (target.relative) {
            resolvedTarget.relative = { path: replacePlaceholders(target.relative.path || '', captures) };
        } else if (target.external) {
            resolvedTarget.external = { url: replacePlaceholders(target.external.url || '', captures) };
        }

        return {
            ruleId: rule._id,
            statusCode,
            isExternal,
            target: resolvedTarget,
        };
    }

    return null;
}

function resolveLocation(location: string, currentUrl: string): string {
    if (location.indexOf('http://') === 0 || location.indexOf('https://') === 0) {
        return location;
    }
    // Relative path — resolve against the current URL's origin
    const protocolEnd = currentUrl.indexOf('://');
    if (protocolEnd === -1) return location;
    const pathStart = currentUrl.indexOf('/', protocolEnd + 3);
    const origin = pathStart === -1 ? currentUrl : currentUrl.substring(0, pathStart);
    return origin + (location.charAt(0) === '/' ? '' : '/') + location;
}

function replacePlaceholders(template: string, captures: string[]): string {
    return template.replace(/\$(\d+)/g, (_, index) => {
        const i = parseInt(index, 10) - 1;
        return i >= 0 && i < captures.length ? captures[i] : '';
    });
}

export function findMatchInRuleSet(path: string, ruleSetPath: string): MatchResult | null {
    const parentPath = '/content' + ruleSetPath;
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

    if (rulesResult.total === 0) return null;

    return findMatchInRules(path, rulesResult.hits);
}

function resolveTargetUrl(match: MatchResult): string {
    if (match.target.external?.url) return match.target.external.url;
    if (match.target.relative?.path) return match.target.relative.path;
    if (match.target.reference?.content) {
        const content = get({ key: match.target.reference.content });
        return content ? content._path : '';
    }
    return '';
}

/**
 * Traces a redirect chain up to 10 steps, following internal rules and external HTTP redirects.
 */
export function traceRedirects(startPath: string, firstMatch: MatchResult, ruleSetPath: string, baseUrl: string): TraceResult {
    const MAX_STEPS = 10;
    const steps: TraceStep[] = [];
    const visitedPaths: Record<string, boolean> = {};
    let loopDetected = false;
    const base = baseUrl.replace(/\/$/, '');

    // First step: the previewed rule itself
    steps.push({
        url: base + startPath,
        statusCode: firstMatch.statusCode,
        isExternal: false,
        note: 'Triggered by previewed rule'
    });

    visitedPaths[startPath] = true;

    let currentTarget = resolveTargetUrl(firstMatch);
    let isExternal = firstMatch.isExternal;

    for (let i = 1; i <= MAX_STEPS; i++) {
        if (!currentTarget) {
            steps.push({ url: '', statusCode: 500, isExternal: false, note: 'Broken target' });
            break;
        }

        const currentUrl = isExternal ? currentTarget : base + currentTarget;
        const currentPath = isExternal ? currentTarget : currentTarget;

        if (visitedPaths[currentPath]) {
            loopDetected = true;
            steps.push({ url: currentUrl, statusCode: 508, isExternal: false, note: 'Loop Detected!' });
            break;
        }

        visitedPaths[currentPath] = true;

        if (!isExternal) {
            const internalMatch = findMatchInRuleSet(currentPath, ruleSetPath);

            if (internalMatch) {
                steps.push({
                    url: currentUrl,
                    statusCode: internalMatch.statusCode,
                    isExternal: false,
                    note: 'Matched internal rule'
                });
                currentTarget = resolveTargetUrl(internalMatch);
                isExternal = internalMatch.isExternal;
                continue;
            } else {
                steps.push({ url: currentUrl, statusCode: 200, isExternal: false, note: 'Final Internal Destination' });
                break;
            }
        } else {
            try {
                const response: HttpResponse = request({
                    url: currentUrl,
                    method: 'GET',
                    followRedirects: false,
                    connectionTimeout: 5000,
                    readTimeout: 5000
                });

                // Find Location header case-insensitively
                let location = '';
                const headerKeys = Object.keys(response.headers);
                for (let h = 0; h < headerKeys.length; h++) {
                    if (headerKeys[h].toLowerCase() === 'location') {
                        location = response.headers[headerKeys[h]];
                        break;
                    }
                }

                if (response.status >= 300 && response.status < 400 && location) {
                    steps.push({
                        url: currentUrl,
                        statusCode: response.status,
                        isExternal: true,
                        note: 'External server redirected'
                    });
                    currentTarget = resolveLocation(location, currentUrl);
                } else {
                    steps.push({ url: currentUrl, statusCode: response.status, isExternal: true, note: 'Final External Destination' });
                    break;
                }
            } catch {
                steps.push({ url: currentUrl, statusCode: 500, isExternal: true, note: 'External request failed or timed out' });
                break;
            }
        }

        if (i === MAX_STEPS) {
            loopDetected = true;
            steps.push({ url: currentUrl, statusCode: 508, isExternal: false, note: 'Max hop count (10) reached' });
        }
    }

    return { steps, loopDetected, finalUrl: steps[steps.length - 1]?.url || '' };
}
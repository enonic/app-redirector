# Enonic Redirector App: Developer Documentation

The Redirector app provides a headless, API-first approach to managing HTTP redirects in Enonic XP8. It allows editors to manage URL forwarding in Content Studio while giving frontend developers a predictable, high-performance GraphQL API to evaluate those rules in real-time.

---

## 1. The Content Model

To understand the API, it helps to know how the data is structured in Content Studio:

* **RuleSet (`com.enonic.app.redirector:ruleSet`):** A folder-like container that holds a specific group of routing rules.
* **Rule (`com.enonic.app.redirector:rule`):** A single redirect instruction inside a RuleSet. It supports three match types (Exact, Prefix, Regex) and three target types (Internal Content, Relative Path, External URL).

**Important:** RuleSets are entirely flat. The order of execution is determined by the manual sorting order of the Rules within the RuleSet folder in Content Studio.

---

## 2. API Usage (Guillotine)

The app extends the standard Enonic Guillotine API with a dedicated `redirect` field. Instead of fetching the raw rules and evaluating them on the client, you pass the incoming request path to the API, and XP evaluates the rules server-side.

### The GraphQL Query

```graphql
query EvaluateRedirect($path: String!, $ruleSet: String) {
  guillotine(project: "myproject", branch: "master", scopeKey: "/my-site") {
    redirect(path: $path, ruleSet: $ruleSet) {
      statusCode
      external
      path
      content { _path pageUrl { path baseUrl } }
      rule { displayName }
    }
  }
}
```

The endpoint is Guillotine's: `/api/com.enonic.app.guillotine:graphql` on the XP web port. `project` and `branch` select the
content; `scopeKey` selects the site whose rules apply (see Auto-Discovery).

### Arguments

| Argument | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `String!` | **Yes** | The incoming request path to evaluate (e.g., `/old-blog-post`). Pass the path only; the query string is the client's to forward. |
| `ruleSet` | `String` | No | The ID (`_id`) or Path (`_path`) of a specific RuleSet to evaluate against. Overrides Auto-Discovery. |

### The Response

`null` when no rule matches. Otherwise a `RedirectResult` with the status code and **exactly one** of three target fields,
mirroring the three target types editors can choose:

| Field | Set for | Description |
| :--- | :--- | :--- |
| `statusCode` | all | `301`, `302` or `410` |
| `external` | External URL targets | Absolute URL, `$n` placeholders substituted |
| `path` | Relative Path targets | Relative path, `$n` placeholders substituted. Mount it where your front end serves the site. |
| `content` | Content targets | The target content. Build its URL like any other content, e.g. `pageUrl { path baseUrl }`, so headless and site-engine deployments both get the right address. |
| `rule` | all | The rule that matched, for debugging and tooling |
| `url` | all | Legacy single string: `external`, `path`, or the content's `_path`, with the incoming query string appended when `path` included one. Prefer the structured fields. |

**Match Found (content target):**
```json
{
  "data": {
    "guillotine": {
      "redirect": {
        "statusCode": 301,
        "external": null,
        "path": null,
        "content": { "_path": "/my-site/new-marketing-campaign", "pageUrl": { "path": "/new-marketing-campaign", "baseUrl": "https://www.example.com" } },
        "rule": { "displayName": "/old-campaign ➔ [301]" }
      }
    }
  }
}
```

**No Match Found:**
```json
{
  "data": {
    "guillotine": {
      "redirect": null
    }
  }
}
```

---

## 3. Auto-Discovery (Zero-Config Resolution)

If you omit the `ruleSet` argument in your GraphQL query, the API utilizes an **Auto-Discovery** fallback. This is highly recommended for standard XP8 setups as it allows the CMS structure to dictate the routing context without frontend configuration changes.

When `ruleSet` is null, the resolver looks for a RuleSet named **`_redirects`**, using the same rule as Guillotine's `${site}` placeholder:

1.  **Nearest Site:** If `scopeKey` names a site, or content inside a site, the RuleSet at `<site>/_redirects` is used.
2.  **Project Root:** Without `scopeKey` (or with `/`), for content outside any site, or when the site has no `_redirects`, the RuleSet at `/_redirects` is used.

A lookup that fails, for example because the caller may not read the branch, returns `null` and is logged on the server.

---

## 4. Frontend Implementation Guide

Because Enonic XP acts as a headless CMS, **your frontend application is responsible for executing the actual HTTP redirect.** The API only returns the *intent*.

Path targets come back as the editor wrote them; content targets come back as content, and `pageUrl { path baseUrl }` gives the address for the selected scope the same way it does for any other content. Forward the incoming query string yourself if your redirects should keep it.

### Example: Next.js Middleware (`middleware.ts`)

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const currentPath = request.nextUrl.pathname;

  // 1. Query the Guillotine API
  const response = await fetch(process.env.ENONIC_GUILLOTINE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `
        query ($path: String!) {
          guillotine(project: "myproject", branch: "master", scopeKey: "/my-site") {
            redirect(path: $path) {
              statusCode
              external
              path
              content { pageUrl { path } }
            }
          }
        }
      `,
      variables: { path: currentPath }
    })
  });

  const { data } = await response.json();
  const redirectRule = data?.guillotine?.redirect;

  // 2. Execute the Redirect if a match is found
  if (redirectRule) {
    if (redirectRule.statusCode === 410) {
      return new NextResponse(null, { status: 410 });
    }
    const target = redirectRule.external
      ?? redirectRule.path
      ?? redirectRule.content?.pageUrl.path;
    const targetUrl = new URL(target, request.nextUrl.origin);
    targetUrl.search = request.nextUrl.search; // forward the incoming query string
    return NextResponse.redirect(targetUrl, redirectRule.statusCode);
  }

  // 3. Continue normal rendering if no match
  return NextResponse.next();
}
```

---

## 5. Editor Preview & Tracing

While the API handles production traffic, the app also includes a built-in **Redirect Tracer** inside Content Studio, provided as a Live View extension ("Redirector"). It is selected automatically in the preview pane whenever a Rule or RuleSet is selected or edited, at the project root as well as inside a site, and lets editors enter a path to test. 

It traces up to 10 hops, evaluating both internal rule chains and external HTTP responses, warning the editor immediately if they have created an infinite redirection loop. For internal previews, the app automatically extracts the `baseUrl` from the nearest Portal App `siteConfig`.
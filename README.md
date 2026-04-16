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
  guillotine {
    redirect(path: $path, ruleSet: $ruleSet) {
      url
      statusCode
    }
  }
}
```

### Arguments

| Argument | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `path` | `String!` | **Yes** | The incoming request path you want to evaluate (e.g., `/old-blog-post`). |
| `ruleSet` | `String` | No | The ID (`_id`) or Path (`_path`) of a specific RuleSet to evaluate against. |

### The Response

If a matching rule is found, the API returns the resolved destination and the HTTP status code. If no rules match the provided path, the API returns `null`.

**Match Found:**
```json
{
  "data": {
    "guillotine": {
      "redirect": {
        "url": "/new-marketing-campaign",
        "statusCode": 301
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

When `ruleSet` is null, the resolver looks for a RuleSet specifically named **`_redirects`**:

1.  **Nearest Site Context:** It first checks if the current execution context belongs to a Site (`portal:site`). If so, it looks for a RuleSet named `_redirects` directly under that Site.
2.  **Project Root:** If no site context is found (or the site lacks a `_redirects` RuleSet), it falls back to the absolute root of the current project and looks for `_redirects` there.

---

## 4. Frontend Implementation Guide

Because Enonic XP acts as a headless CMS, **your frontend application is responsible for executing the actual HTTP redirect.** The API only returns the *intent*.

Furthermore, the API returns internal targets as relative paths (e.g., `/about-us`). The frontend is responsible for appending these to the correct Base URL if absolute URLs are required by your framework.

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
          guillotine {
            redirect(path: $path) { url statusCode }
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
    // Handle external vs internal target formatting
    const targetUrl = redirectRule.url.startsWith('http') 
      ? redirectRule.url 
      : new URL(redirectRule.url, request.nextUrl.origin);

    return NextResponse.redirect(targetUrl, redirectRule.statusCode);
  }

  // 3. Continue normal rendering if no match
  return NextResponse.next();
}
```

---

## 5. Editor Preview & Tracing

While the API handles production traffic, the app also includes a built-in **Redirect Tracer** inside Content Studio. When editors click "Preview" on a Rule, the app simulates the routing engine. 

It traces up to 10 hops, evaluating both internal rule chains and external HTTP responses, warning the editor immediately if they have created an infinite redirection loop. For internal previews, the app automatically extracts the `baseUrl` from the nearest Portal App `siteConfig`.
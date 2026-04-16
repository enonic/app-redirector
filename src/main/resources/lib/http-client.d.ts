export interface HttpRequestParams {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    connectionTimeout?: number;
    readTimeout?: number;
    body?: string;
    contentType?: string;
    followRedirects?: boolean;
}

export interface HttpResponse {
    status: number;
    message: string;
    body: string;
    contentType: string;
    headers: Record<string, string>;
}

export function request(params: HttpRequestParams): HttpResponse;

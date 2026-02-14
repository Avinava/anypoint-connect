/**
 * HTTP Client
 * Axios wrapper with authentication and rate limiting
 */

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { TokenManager } from '../auth/TokenManager.js';
import { RateLimiter, type RateLimiterConfig } from './RateLimiter.js';

const DEFAULT_BASE_URL = 'https://anypoint.mulesoft.com';

export interface HttpClientConfig {
    baseUrl?: string;
    tokenManager: TokenManager;
    rateLimiter?: RateLimiterConfig;
    timeout?: number;
}

export class HttpClient {
    private readonly client: AxiosInstance;
    private readonly tokenManager: TokenManager;
    private readonly rateLimiter: RateLimiter;

    constructor(config: HttpClientConfig) {
        this.tokenManager = config.tokenManager;
        this.rateLimiter = new RateLimiter(config.rateLimiter);

        this.client = axios.create({
            baseURL: config.baseUrl || DEFAULT_BASE_URL,
            timeout: config.timeout || 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Add auth interceptor
        this.client.interceptors.request.use(async (requestConfig) => {
            const accessToken = await this.tokenManager.getAccessToken();
            requestConfig.headers.Authorization = `Bearer ${accessToken}`;
            return requestConfig;
        });
    }

    async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
        return this.rateLimiter.execute(async () => {
            const response: AxiosResponse<T> = await this.client.get(url, config);
            return response.data;
        });
    }

    async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
        return this.rateLimiter.execute(async () => {
            const response: AxiosResponse<T> = await this.client.post(url, data, config);
            return response.data;
        });
    }

    async put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
        return this.rateLimiter.execute(async () => {
            const response: AxiosResponse<T> = await this.client.put(url, data, config);
            return response.data;
        });
    }

    async patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
        return this.rateLimiter.execute(async () => {
            const response: AxiosResponse<T> = await this.client.patch(url, data, config);
            return response.data;
        });
    }

    async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T> {
        return this.rateLimiter.execute(async () => {
            const response: AxiosResponse<T> = await this.client.delete(url, config);
            return response.data;
        });
    }

    async download(url: string, config?: AxiosRequestConfig): Promise<Buffer> {
        return this.rateLimiter.execute(async () => {
            const response = await this.client.get(url, {
                ...config,
                responseType: 'arraybuffer',
            });
            return Buffer.from(response.data);
        });
    }
}

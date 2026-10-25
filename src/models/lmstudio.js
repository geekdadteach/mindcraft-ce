import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';
import { lmUrlList, pickLmUrl, markLmUrlDown } from '../utils/lm_endpoints.js';

export class LMStudio {
    static prefix = 'lmstudio';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        // [ai-player] fallback_urls / connect_timeout_ms / embed_timeout_ms are ours, not OpenAI request fields (sendRequest spreads params).
        const { fallback_urls, connect_timeout_ms, embed_timeout_ms, ...rest } = params || {};
        this.params = rest;
        this.urls = lmUrlList(url || 'http://localhost:1234/v1', fallback_urls);
        this.connect_ms = Number(connect_timeout_ms) || 1500;
        this.embed_clients = new Map(this.urls.map(u => [u, new OpenAIApi({ baseURL: u, apiKey: 'lm-studio', timeout: Number(embed_timeout_ms) || 15000, maxRetries: 0 })]));
        this.openai = new OpenAIApi({
            baseURL: url || 'http://localhost:1234/v1',
            apiKey: 'lm-studio', // LM Studio ignores this but the client requires a non-empty value
        });
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(strictFormat(turns));
        let model = this.model_name || 'andy-4.1';
        let res = null;

        try {
            console.log('Awaiting LM Studio response from model', model);
            const pack = {
                model,
                messages,
                stop: stop_seq,
                ...(this.params || {})
            };
            const completion = await this.openai.chat.completions.create(pack);
            if (completion.choices[0].finish_reason === 'length')
                throw new Error('Context length exceeded');
            console.log('Received.');
            res = completion.choices[0].message.content;
            if (res.includes('</think>')) {
                if (!res.includes('<think>')) res = '<think>' + res;
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
            } else {
                console.log(err);
                res = 'My brain disconnected, try again.';
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                {
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const url = await pickLmUrl(this.urls, { connectMs: this.connect_ms });
        if (!url) throw new Error(`Connection error. (no LM Studio endpoint reachable: ${this.urls.join(' ')})`);
        let embedding;
        try {
            embedding = await this.embed_clients.get(url).embeddings.create({
                model: this.model_name || 'text-embedding-nomic-embed-text-v1.5',
                input: text,
                encoding_format: 'float',
            });
        } catch (err) {
            // [ai-player] Connect failure: skip this endpoint for 30 s. Callers already fall back to word overlap / keywords.
            if (err instanceof OpenAIApi.APIConnectionError && !(err instanceof OpenAIApi.APIConnectionTimeoutError)) markLmUrlDown(url);
            throw err;
        }
        return embedding.data[0].embedding;
    }
}

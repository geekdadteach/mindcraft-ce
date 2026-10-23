// [ai-player] Placeholder strings the model wrappers return when the API gave no usable reply.
export const MODEL_ERROR_REPLIES = [
    'No response data.',
    'My brain disconnected, try again.',
    'I thought too hard, sorry, try again.',
];
export function isModelErrorReply(text) {
    if (typeof text !== 'string') return text == null;
    const t = text.trim();
    return t.length === 0 || MODEL_ERROR_REPLIES.includes(t);
}

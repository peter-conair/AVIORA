'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError, isForbidden } from '@/lib/api-client';
import {
  toCitations,
  type AiAskResponse,
  type AiCitation,
  type AiConversationResponse,
  type AiConversationSummary,
  type AiConversationsResponse,
  type AiUsage,
} from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: AiCitation[];
}

export default function AssistantPage() {
  const t = useTranslations('assistant');
  const tc = useTranslations('common');

  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [conversations, setConversations] = useState<AiConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);

  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const [forbidden, setForbidden] = useState(false);
  const [notEntitled, setNotEntitled] = useState(false);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<AiUsage>('/ai/usage'),
      api.get<AiConversationsResponse>('/ai/conversations'),
    ])
      .then(([usageRes, listRes]) => {
        if (cancelled) return;
        setUsage(usageRes);
        setConversations(listRes.conversations);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isForbidden(err)) setForbidden(true);
        else setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUsage = async () => {
    try {
      setUsage(await api.get<AiUsage>('/ai/usage'));
    } catch {
      // Usage is informational — a failure here must never break the chat.
    }
  };

  const refreshConversations = async () => {
    try {
      const res = await api.get<AiConversationsResponse>('/ai/conversations');
      setConversations(res.conversations);
    } catch {
      // The thread itself still works without an up-to-date list.
    }
  };

  const handleNewConversation = () => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setLimitMessage(null);
  };

  const handleOpenConversation = async (id: string) => {
    setConversationId(id);
    setMessages([]);
    setError(null);
    setLimitMessage(null);
    setThreadLoading(true);
    try {
      const res = await api.get<AiConversationResponse>(`/ai/conversations/${id}`);
      setMessages(
        res.conversation.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: toCitations(m.citations),
        })),
      );
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
    } finally {
      setThreadLoading(false);
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (text.length < 2 || sending) return;

    setError(null);
    setLimitMessage(null);
    setSending(true);
    const optimisticId = `local-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: optimisticId, role: 'user', content: text, citations: [] },
    ]);
    setQuestion('');

    try {
      const res = await api.post<AiAskResponse>('/ai/ask', {
        question: text,
        ...(conversationId ? { conversationId } : {}),
      });
      setConversationId(res.conversationId);
      setMessages((prev) => [
        ...prev,
        {
          id: `${res.conversationId}-${prev.length}`,
          role: 'assistant',
          content: res.answer,
          citations: res.citations ?? [],
        },
      ]);
      setUsage((prev) =>
        prev
          ? {
              ...prev,
              remaining: res.remaining,
              requests: Math.max(0, prev.dailyRequestCap - res.remaining),
            }
          : prev,
      );
      void refreshUsage();
      void refreshConversations();
    } catch (err: unknown) {
      // Roll the optimistic message back so the thread matches the server.
      setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
      setQuestion(text);
      if (err instanceof ApiError && err.code === 'ENTITLEMENT_REQUIRED') {
        setNotEntitled(true);
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setLimitMessage(err.message);
      } else if (err instanceof ApiError && err.status === 403) {
        setNotEntitled(true);
      } else {
        setError(err instanceof ApiError ? err.message : tc('errorGeneric'));
      }
    } finally {
      setSending(false);
    }
  };

  if (forbidden) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t('forbidden')}</p>
        </Card>
      </div>
    );
  }

  const used = usage ? Math.max(0, usage.dailyRequestCap - usage.remaining) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-slate-900">{t('title')}</h1>
        {usage ? (
          <span className="text-xs text-slate-500">
            {t('usage', { used, cap: usage.dailyRequestCap })}
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-500">{tc('loading')}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="lg:w-56 lg:shrink-0">
            <Card
              title={t('conversations')}
              actions={
                <button
                  type="button"
                  onClick={handleNewConversation}
                  className="text-sm font-medium text-brand-700 hover:underline"
                >
                  {t('newConversation')}
                </button>
              }
            >
              {conversations.length === 0 ? (
                <p className="text-sm text-slate-500">{t('conversationsEmpty')}</p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto lg:max-h-none">
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => void handleOpenConversation(conversation.id)}
                        className={`w-full truncate rounded-lg px-2 py-1.5 text-start text-sm ${
                          conversationId === conversation.id
                            ? 'bg-brand-700 text-white'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {conversation.title ?? t('untitled')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {notEntitled ? (
              <Card>
                <p className="text-sm text-slate-600">{t('notEntitled')}</p>
              </Card>
            ) : null}
            {limitMessage ? (
              <Card>
                <p className="text-sm text-amber-800">{limitMessage}</p>
              </Card>
            ) : null}
            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            <Card>
              {threadLoading ? (
                <p className="py-6 text-center text-sm text-slate-500">{tc('loading')}</p>
              ) : messages.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-500">{t('threadEmpty')}</p>
              ) : (
                <ul className="flex max-h-[26rem] flex-col gap-3 overflow-y-auto">
                  {messages.map((message) => (
                    <li
                      key={message.id}
                      className={`flex flex-col gap-1 ${
                        message.role === 'user' ? 'items-end' : 'items-start'
                      }`}
                    >
                      <div
                        className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${
                          message.role === 'user'
                            ? 'bg-brand-700 text-white'
                            : 'bg-slate-100 text-slate-800'
                        }`}
                      >
                        {message.content}
                      </div>
                      {message.role === 'assistant' && message.citations.length > 0 ? (
                        <ul className="flex max-w-[85%] flex-wrap gap-1">
                          {message.citations.map((citation, index) => (
                            <li key={`${message.id}-${citation.code}-${index}`}>
                              <Badge tone="gray">
                                {citation.kind}: {citation.title}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                  {sending ? <li className="text-xs text-slate-500">{t('thinking')}</li> : null}
                </ul>
              )}
            </Card>

            <form onSubmit={handleSend} className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t('inputPlaceholder')}
                  aria-label={t('inputLabel')}
                  maxLength={2000}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600"
                />
                <Button type="submit" disabled={sending || question.trim().length < 2}>
                  {sending ? t('sending') : t('send')}
                </Button>
              </div>
              <p className="text-xs text-slate-500">{t('disclaimer')}</p>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

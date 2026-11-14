import type { ImpactResult } from '@/ai/impact';
import { displayTime, safeUrl } from '@/lib/client';
import { Badge } from './ui/badge';

export function ImpactExplanation({ impact, locationName, timezone }: { impact: ImpactResult; locationName: string; timezone?: string }) {
  const signal=impact.signal;
  return <div className="mt-4 space-y-3 rounded-xl border border-border bg-muted/40 p-4" data-testid="impact-analysis">
    <p className="section-kicker">Влияние на бизнес</p>
    {impact.error && <p role="alert" className="text-sm text-red-800">Ошибка модели: {impact.error.message}</p>}
    {impact.fact && <div><p className="text-xs font-semibold">Факт из публикации</p><blockquote className="mt-1 border-l-2 border-primary/30 pl-3 text-sm leading-6">{impact.fact}</blockquote></div>}
    {impact.affectedProcess && <p className="text-sm"><strong>Затронутый процесс:</strong> {impact.affectedProcess}</p>}
    {impact.possibleImpact && <div><p className="text-xs font-semibold">Гипотеза влияния</p><p className="mt-1 text-sm leading-6">{impact.possibleImpact}</p></div>}
    {!!impact.assumptions.length && <div><p className="text-xs font-semibold">Допущения и ограничения</p><ul className="mt-1 list-disc space-y-1 pl-4 text-sm leading-6">{impact.assumptions.map((assumption,index)=><li key={index}>{assumption}</li>)}</ul></div>}
    {impact.question && <p className="text-sm leading-6 text-amber-900">Требуется уточнение: {impact.question}</p>}
    {signal && <div className="space-y-2 border-t border-border pt-3" data-testid="business-signal"><Badge tone={signal.type==='threat' ? 'warning' : 'success'}>{signal.type==='threat' ? 'Угроза' : 'Возможность'}</Badge><p className="text-sm font-semibold">{signal.title}</p><p className="text-xs text-muted-foreground">{locationName} · {displayTime(signal.startsAt,timezone)} — {displayTime(signal.endsAt,timezone)}</p><p className="text-sm leading-6"><strong>Рекомендуемое действие:</strong> {signal.recommendedAction}</p></div>}
    {safeUrl(impact.sourceUrl) && <a className="inline-block text-xs font-semibold text-primary" href={safeUrl(impact.sourceUrl)} target="_blank" rel="noopener noreferrer">Источник публикации ↗</a>}
    {impact.model && <p className="text-xs text-muted-foreground">Модель: {impact.model}</p>}
  </div>;
}

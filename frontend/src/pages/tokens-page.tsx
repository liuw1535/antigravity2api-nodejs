import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Upload, Download, Trash2, MoreHorizontal, BarChart3, Power, PowerOff, ChevronDown, ChevronUp, HelpCircle, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

interface Token {
  id: string;
  expires_in: number;
  timestamp: number;
  enable: boolean;
  projectId?: string | null;
  email?: string | null;
  hasQuota?: boolean;
}

interface QuotaModel {
  remaining: number;
  resetTime: string;
  resetTimeRaw?: string;
}

interface QuotaData {
  models: Record<string, QuotaModel>;
  requestCounts?: Record<string, number>;
  lastUpdated?: string;
}

interface QuotaGroup {
  key: string;
  label: string;
  iconSrc: string;
  match: (modelId: string) => boolean;
}

const QUOTA_GROUPS: QuotaGroup[] = [
  { key: 'claude', label: 'Claude', iconSrc: '/assets/icons/claude.svg', match: (m) => m.toLowerCase().includes('claude') },
  { key: 'banana', label: 'Banana', iconSrc: '/assets/icons/banana.svg', match: (m) => m.toLowerCase().includes('gemini-3-pro-image') },
  { key: 'gemini', label: 'Gemini', iconSrc: '/assets/icons/gemini.svg', match: (m) => m.toLowerCase().includes('gemini') || m.toLowerCase().includes('publishers/google/') },
  { key: 'other', label: '其他', iconSrc: '', match: () => true },
];

const QUOTA_SUMMARY_KEYS = ['claude', 'gemini', 'banana'];

const quotaCache = new Map<string, { data: QuotaData; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedQuota(tokenId: string): QuotaData | null {
  const cached = quotaCache.get(tokenId);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    quotaCache.delete(tokenId);
    return null;
  }
  return cached.data;
}

function setCachedQuota(tokenId: string, data: QuotaData) {
  quotaCache.set(tokenId, { data, timestamp: Date.now() });
}

function clearCachedQuota(tokenId?: string) {
  if (tokenId) {
    quotaCache.delete(tokenId);
  } else {
    quotaCache.clear();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toPercentage(fraction: number): number {
  return clamp01(fraction) * 100;
}

function formatPercentage(fraction: number): string {
  return `${toPercentage(fraction).toFixed(1)}%`;
}

function getBarColor(percentage: number): string {
  if (percentage > 50) return 'bg-green-500';
  if (percentage > 20) return 'bg-yellow-500';
  return 'bg-red-500';
}

function groupModels(models: Record<string, QuotaModel>): Record<string, { modelId: string; quota: QuotaModel }[]> {
  const grouped: Record<string, { modelId: string; quota: QuotaModel }[]> = { claude: [], gemini: [], banana: [], other: [] };
  Object.entries(models || {}).forEach(([modelId, quota]) => {
    const groupKey = (QUOTA_GROUPS.find((g) => g.match(modelId)) || QUOTA_GROUPS[QUOTA_GROUPS.length - 1]).key;
    if (!grouped[groupKey]) grouped[groupKey] = [];
    grouped[groupKey].push({ modelId, quota });
  });
  return grouped;
}

function summarizeGroup(items: { modelId: string; quota: QuotaModel }[], requestCount = 0) {
  if (!items || items.length === 0) {
    return { percentage: 0, percentageText: '--', resetTime: '--', estimatedRequests: 0 };
  }
  let minRemaining = 1;
  let earliestResetMs: number | null = null;
  let earliestResetText: string | null = null;

  items.forEach(({ quota }) => {
    const remaining = clamp01(quota?.remaining);
    if (remaining < minRemaining) minRemaining = remaining;
    const resetRaw = quota?.resetTimeRaw;
    const resetText = quota?.resetTime;
    if (resetRaw) {
      const ms = Date.parse(resetRaw);
      if (Number.isFinite(ms) && (earliestResetMs === null || ms < earliestResetMs)) {
        earliestResetMs = ms;
        earliestResetText = resetText || null;
      }
    } else if (!earliestResetText && resetText) {
      earliestResetText = resetText;
    }
  });

  const percentageValue = toPercentage(minRemaining);
  const totalFromThreshold = Math.floor(percentageValue / 0.6667);
  const estimatedRequests = Math.max(0, totalFromThreshold - requestCount);

  return {
    percentage: percentageValue,
    percentageText: formatPercentage(minRemaining),
    resetTime: earliestResetText || '--',
    estimatedRequests,
  };
}

function GroupIcon({ groupKey, className }: { groupKey: string; className?: string }) {
  const group = QUOTA_GROUPS.find((g) => g.key === groupKey);
  if (groupKey === 'other' || !group?.iconSrc) {
    return <HelpCircle className={cn('text-muted-foreground', className)} />;
  }
  return <img src={group.iconSrc} alt={group.label} className={className} />;
}

function QuotaSummaryBar({ groupKey, items, requestCount = 0 }: { groupKey: string; items: { modelId: string; quota: QuotaModel }[]; requestCount?: number }) {
  const group = QUOTA_GROUPS.find((g) => g.key === groupKey);
  const summary = summarizeGroup(items, requestCount);
  const barColorClass = summary.percentageText === '--' ? 'bg-gray-400' : getBarColor(summary.percentage);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 min-w-[80px] sm:min-w-[100px]">
            <GroupIcon groupKey={groupKey} className="h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', barColorClass)} style={{ width: `${summary.percentage}%` }} />
            </div>
            <span className="text-xs text-muted-foreground w-10 text-right">{summary.percentageText}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">
            {group?.label}: {summary.percentageText}
            <br />
            重置: {summary.resetTime}
            {summary.estimatedRequests > 0 && <><br />预估可用: ~{summary.estimatedRequests}次</>}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function QuotaSummaryCell({ tokenId, enabled }: { tokenId: string; enabled: boolean }) {
  const [quotaData, setQuotaData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!enabled || loadedRef.current) return;

    const cached = getCachedQuota(tokenId);
    if (cached) {
      setQuotaData(cached);
      loadedRef.current = true;
      return;
    }

    const loadQuota = async () => {
      setLoading(true);
      setError(false);
      try {
        const response = await api.get<{ success: boolean; data: QuotaData }>(`/tokens/${tokenId}/quotas`);
        if (response.data) {
          setCachedQuota(tokenId, response.data);
          setQuotaData(response.data);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        loadedRef.current = true;
      }
    };

    loadQuota();
  }, [tokenId, enabled]);

  if (!enabled) return <span className="text-xs text-muted-foreground">已禁用</span>;
  if (loading) return <Skeleton className="h-4 w-32" />;
  if (error) return <span className="text-xs text-muted-foreground">加载失败</span>;
  if (!quotaData?.models || Object.keys(quotaData.models).length === 0) {
    return <span className="text-xs text-muted-foreground">暂无额度</span>;
  }

  const grouped = groupModels(quotaData.models);
  const requestCounts = quotaData.requestCounts || {};

  return (
    <div className="flex flex-col gap-1">
      {QUOTA_SUMMARY_KEYS.map((key) => (
        <QuotaSummaryBar key={key} groupKey={key} items={grouped[key] || []} requestCount={requestCounts[key] || 0} />
      ))}
    </div>
  );
}

function ExpandedQuotaDetail({ tokenId, enabled, onViewDetail }: { tokenId: string; enabled: boolean; onViewDetail: () => void }) {
  const [quotaData, setQuotaData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const cached = getCachedQuota(tokenId);
    if (cached) {
      setQuotaData(cached);
      return;
    }

    const loadQuota = async () => {
      setLoading(true);
      setError(false);
      try {
        const response = await api.get<{ success: boolean; data: QuotaData }>(`/tokens/${tokenId}/quotas`);
        if (response.data) {
          setCachedQuota(tokenId, response.data);
          setQuotaData(response.data);
        }
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    loadQuota();
  }, [tokenId, enabled]);

  if (!enabled) return <p className="text-sm text-muted-foreground">Token 已禁用</p>;
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error) return <p className="text-sm text-muted-foreground">加载额度失败</p>;
  if (!quotaData?.models || Object.keys(quotaData.models).length === 0) {
    return <p className="text-sm text-muted-foreground">暂无额度信息</p>;
  }

  const grouped = groupModels(quotaData.models);
  const requestCounts = quotaData.requestCounts || {};

  const renderGroupDetail = (groupKey: string, items: { modelId: string; quota: QuotaModel }[]) => {
    if (items.length === 0) return null;
    const group = QUOTA_GROUPS.find((g) => g.key === groupKey);
    const summary = summarizeGroup(items, requestCounts[groupKey] || 0);
    const estimatedText = summary.estimatedRequests > 0 ? `~${summary.estimatedRequests}次` : '';

    return (
      <div key={groupKey} className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GroupIcon groupKey={groupKey} className="h-4 w-4" />
          <span>{group?.label}</span>
          <span className="text-muted-foreground font-normal">
            {summary.percentageText} · 重置: {summary.resetTime} {estimatedText && `· ${estimatedText}`}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pl-6">
          {items.map(({ modelId, quota }) => {
            const percentage = toPercentage(quota?.remaining);
            const shortName = modelId.replace('models/', '').replace('publishers/google/', '').split('/').pop();
            return (
              <div key={modelId} className="flex items-center gap-2 text-sm" title={modelId}>
                <span className="w-32 truncate text-muted-foreground">{shortName}</span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[60px]">
                  <div className={cn('h-full rounded-full', getBarColor(percentage))} style={{ width: `${percentage}%` }} />
                </div>
                <span className="w-12 text-right text-muted-foreground">{formatPercentage(quota?.remaining)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {renderGroupDetail('claude', grouped.claude || [])}
      {renderGroupDetail('gemini', grouped.gemini || [])}
      {renderGroupDetail('banana', grouped.banana || [])}
      {(grouped.other?.length ?? 0) > 0 && renderGroupDetail('other', grouped.other || [])}
      <div className="flex justify-end pt-2">
        <Button variant="outline" size="sm" onClick={onViewDetail}>
          <BarChart3 className="mr-2 h-4 w-4" />
          查看完整详情
        </Button>
      </div>
    </div>
  );
}

function QuotaDetailModal({ tokenId, tokens, open, onOpenChange }: { tokenId: string; tokens: Token[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [currentTokenId, setCurrentTokenId] = useState(tokenId);
  const [quotaData, setQuotaData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(false);

  const loadQuota = useCallback(async (tid: string, forceRefresh = false) => {
    if (!forceRefresh) {
      const cached = getCachedQuota(tid);
      if (cached) {
        setQuotaData(cached);
        return;
      }
    } else {
      clearCachedQuota(tid);
    }

    setLoading(true);
    try {
      const url = `/tokens/${tid}/quotas${forceRefresh ? '?refresh=true' : ''}`;
      const response = await api.get<{ success: boolean; data: QuotaData }>(url);
      if (response.data) {
        setCachedQuota(tid, response.data);
        setQuotaData(response.data);
      }
    } catch {
      toast.error('加载额度失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && currentTokenId) {
      loadQuota(currentTokenId);
    }
  }, [open, currentTokenId, loadQuota]);

  useEffect(() => {
    setCurrentTokenId(tokenId);
  }, [tokenId]);

  const grouped = quotaData?.models ? groupModels(quotaData.models) : {};
  const requestCounts = quotaData?.requestCounts || {};

  const renderGroup = (groupKey: string, items: { modelId: string; quota: QuotaModel }[]) => {
    const group = QUOTA_GROUPS.find((g) => g.key === groupKey);
    const summary = summarizeGroup(items, requestCounts[groupKey] || 0);
    const estimatedText = summary.estimatedRequests > 0 ? ` · ~${summary.estimatedRequests}次` : '';

    return (
      <div key={groupKey} className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GroupIcon groupKey={groupKey} className="h-4 w-4" />
            <span className="font-medium">{group?.label}</span>
          </div>
          <span className="text-sm text-muted-foreground">
            {summary.percentageText} · 重置: {summary.resetTime}{estimatedText}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无</p>
        ) : (
          <div className="grid gap-2">
            {items.map(({ modelId, quota }) => {
              const percentage = toPercentage(quota?.remaining);
              const shortName = modelId.replace('models/', '').replace('publishers/google/', '').split('/').pop();
                return (
                <div key={modelId} className="flex items-center gap-2" title={`${modelId} - 重置: ${quota.resetTime}`}>
                  <span className="text-sm w-full sm:w-48 truncate">{shortName}</span>
                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                    <div className={cn('h-full rounded-full', getBarColor(percentage))} style={{ width: `${percentage}%` }} />
                  </div>
                  <span className="text-sm w-14 text-right">{formatPercentage(quota?.remaining)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              <span>模型额度</span>
            </div>
            {quotaData?.lastUpdated && (
              <span className="text-sm font-normal text-muted-foreground flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {new Date(quotaData.lastUpdated).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <Select value={currentTokenId} onValueChange={setCurrentTokenId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择 Token" />
            </SelectTrigger>
            <SelectContent>
              {tokens.filter((t) => t.enable).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.email || t.id.substring(0, 16) + '...'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 overflow-y-auto space-y-6 py-4">
          {loading ? (
            <div className="space-y-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !quotaData?.models || Object.keys(quotaData.models).length === 0 ? (
            <p className="text-center text-muted-foreground py-8">暂无额度信息</p>
          ) : (
            <>
              {renderGroup('claude', grouped.claude || [])}
              {renderGroup('gemini', grouped.gemini || [])}
              {renderGroup('banana', grouped.banana || [])}
              {(grouped.other?.length ?? 0) > 0 && renderGroup('other', grouped.other || [])}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          <Button onClick={() => loadQuota(currentTokenId, true)} disabled={loading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            刷新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TokensPage() {
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [deleteTokenId, setDeleteTokenId] = useState<string | null>(null);
  const [newToken, setNewToken] = useState({ access_token: '', refresh_token: '' });
  const [quotaModalTokenId, setQuotaModalTokenId] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);

  const { data: tokens = [], isLoading } = useQuery<Token[]>({
    queryKey: ['tokens'],
    queryFn: async () => {
      const response = await api.get<{ success: boolean; data: Token[] }>('/tokens');
      return response.data;
    },
  });

  const addMutation = useMutation({
    mutationFn: (data: { access_token: string; refresh_token: string }) => api.post('/tokens', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      setShowAddDialog(false);
      setNewToken({ access_token: '', refresh_token: '' });
      toast.success('Token 添加成功');
    },
    onError: () => toast.error('添加失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (tokenId: string) => api.delete(`/tokens/${tokenId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      setDeleteTokenId(null);
      toast.success('Token 已删除');
    },
    onError: () => toast.error('删除失败'),
  });

  const refreshMutation = useMutation({
    mutationFn: (tokenId: string) => api.post(`/tokens/${tokenId}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success('Token 已刷新');
    },
    onError: () => toast.error('刷新失败'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ tokenId, enable }: { tokenId: string; enable: boolean }) =>
      api.put(`/tokens/${tokenId}`, { enable }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success('状态已更新');
    },
    onError: () => toast.error('更新失败'),
  });

  const reloadMutation = useMutation({
    mutationFn: () => api.post('/tokens/reload'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success('已重新加载');
    },
  });

  const handleRefreshAllQuotas = async () => {
    const enabledTokens = tokens.filter((t) => t.enable);
    if (enabledTokens.length === 0) {
      toast.warning('没有已启用的 Token 可刷新');
      return;
    }

    setRefreshingQuotas(true);
    enabledTokens.forEach((t) => clearCachedQuota(t.id));

    try {
      await Promise.all(
        enabledTokens.map(async (token) => {
          try {
            const response = await api.get<{ success: boolean; data: QuotaData }>(`/tokens/${token.id}/quotas?refresh=true`);
            if (response.data) {
              setCachedQuota(token.id, response.data);
            }
          } catch {
          }
        })
      );
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success(`已刷新 ${enabledTokens.length} 个 Token 的额度`);
    } catch {
      toast.error('刷新额度失败');
    } finally {
      setRefreshingQuotas(false);
    }
  };

  const handleRefreshSingleQuota = async (tokenId: string) => {
    clearCachedQuota(tokenId);
    try {
      const response = await api.get<{ success: boolean; data: QuotaData }>(`/tokens/${tokenId}/quotas?refresh=true`);
      if (response.data) {
        setCachedQuota(tokenId, response.data);
      }
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success('额度已刷新');
    } catch {
      toast.error('刷新额度失败');
    }
  };

  const handleExport = async () => {
    if (!password) {
      toast.error('请输入密码');
      return;
    }
    try {
      const response = await api.post<{ success: boolean; data: { tokens: Token[] } }>('/tokens/export', { password });
      const exportData = response.data;
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tokens-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('导出成功');
      setShowExportDialog(false);
      setPassword('');
    } catch {
      toast.error('导出失败，请检查密码是否正确');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    setShowImportDialog(true);
    e.target.value = '';
  };

  const handleImport = async () => {
    if (!importFile || !password) {
      toast.error('请选择文件并输入密码');
      return;
    }
    try {
      const text = await importFile.text();
      const data = JSON.parse(text);
      await api.post('/tokens/import', { password, data });
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
      toast.success('导入成功');
      setShowImportDialog(false);
      setImportFile(null);
      setPassword('');
    } catch {
      toast.error('导入失败，请检查密码是否正确');
    }
  };

  const toggleRowExpand = (tokenId: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) {
        next.delete(tokenId);
      } else {
        next.add(tokenId);
      }
      return next;
    });
  };

  const isExpired = (expiresAt: number) => Date.now() > expiresAt;

  const enabledCount = useMemo(() => tokens.filter((t) => t.enable).length, [tokens]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Token 管理</h2>
          <p className="text-muted-foreground">
            管理 API Token · 共 {tokens.length} 个 ({enabledCount} 启用)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleRefreshAllQuotas} disabled={refreshingQuotas}>
            <BarChart3 className={cn('mr-2 h-4 w-4', refreshingQuotas && 'animate-pulse')} />
            刷新额度
          </Button>
          <Button variant="outline" size="sm" onClick={() => reloadMutation.mutate()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重新加载
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowExportDialog(true)}>
            <Download className="mr-2 h-4 w-4" />
            导出
          </Button>
          <Button variant="outline" size="sm" asChild>
            <label>
              <Upload className="mr-2 h-4 w-4" />
              导入
              <input type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
            </label>
          </Button>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                添加 Token
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>添加 Token</DialogTitle>
                <DialogDescription>输入 Access Token 和 Refresh Token</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Access Token</Label>
                  <Input
                    value={newToken.access_token}
                    onChange={(e) => setNewToken({ ...newToken, access_token: e.target.value })}
                    placeholder="ya29..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Refresh Token</Label>
                  <Input
                    value={newToken.refresh_token}
                    onChange={(e) => setNewToken({ ...newToken, refresh_token: e.target.value })}
                    placeholder="1//..."
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAddDialog(false)}>取消</Button>
                <Button onClick={() => addMutation.mutate(newToken)} disabled={addMutation.isPending}>
                  添加
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="grid grid-cols-1 gap-3 md:hidden">
        {tokens.map((token) => {
          const expiresAt = token.timestamp + (token.expires_in || 3599) * 1000;
          const expired = isExpired(expiresAt);
          
          return (
            <Card key={token.id} className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0 mr-2">
                  <p className="font-medium truncate">{token.email || '-'}</p>
                  <p className="text-xs text-muted-foreground font-mono">{token.id.substring(0, 16)}...</p>
                </div>
                {!token.enable ? (
                  <Badge variant="secondary" className="shrink-0">已禁用</Badge>
                ) : expired ? (
                  <Badge variant="destructive" className="shrink-0">已过期</Badge>
                ) : (
                  <Badge variant="default" className="shrink-0">活跃</Badge>
                )}
              </div>
              
              <div className="text-sm mb-3 text-muted-foreground">
                <span className="mr-2">过期时间:</span>
                <span>{formatDate(expiresAt)}</span>
              </div>
              
              <div className="mb-3">
                <QuotaSummaryCell tokenId={token.id} enabled={token.enable} />
              </div>

              <div className="flex flex-wrap gap-2 pt-2 border-t">
                <Button variant="outline" size="sm" onClick={() => setQuotaModalTokenId(token.id)}>
                  <BarChart3 className="mr-1 h-3.5 w-3.5" />
                  详情
                </Button>
                <Button variant="outline" size="sm" onClick={() => handleRefreshSingleQuota(token.id)}>
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  刷新
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => toggleMutation.mutate({ tokenId: token.id, enable: !token.enable })}
                >
                  {token.enable ? <PowerOff className="mr-1 h-3.5 w-3.5" /> : <Power className="mr-1 h-3.5 w-3.5" />}
                  {token.enable ? '禁用' : '启用'}
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="text-destructive hover:text-destructive" 
                  onClick={() => setDeleteTokenId(token.id)}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Desktop Table View */}
      <Card className="hidden md:block">
        <CardHeader>
          <CardTitle>Token 列表</CardTitle>
          <CardDescription>点击行展开查看额度详情</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[30px]"></TableHead>
                  <TableHead>邮箱 / Token ID</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>过期时间</TableHead>
                  <TableHead>额度摘要</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => {
                  const expiresAt = token.timestamp + (token.expires_in || 3599) * 1000;
                  const expired = isExpired(expiresAt);
                  const isExpanded = expandedRows.has(token.id);
                  return (
                    <>
                      <TableRow key={token.id} className="cursor-pointer hover:bg-muted/50" onClick={() => toggleRowExpand(token.id)}>
                        <TableCell>
                          {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{token.email || '-'}</span>
                            <span className="font-mono text-xs text-muted-foreground">{token.id.substring(0, 16)}...</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {!token.enable ? (
                            <Badge variant="secondary">已禁用</Badge>
                          ) : expired ? (
                            <Badge variant="destructive">已过期</Badge>
                          ) : (
                            <Badge variant="default">活跃</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(expiresAt)}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <QuotaSummaryCell tokenId={token.id} enabled={token.enable} />
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setQuotaModalTokenId(token.id)}>
                                <BarChart3 className="mr-2 h-4 w-4" />
                                查看额度
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleRefreshSingleQuota(token.id)}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                刷新额度
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => refreshMutation.mutate(token.id)}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                刷新 Token
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => toggleMutation.mutate({ tokenId: token.id, enable: !token.enable })}>
                                {token.enable ? (
                                  <>
                                    <PowerOff className="mr-2 h-4 w-4" />
                                    禁用
                                  </>
                                ) : (
                                  <>
                                    <Power className="mr-2 h-4 w-4" />
                                    启用
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTokenId(token.id)}>
                                <Trash2 className="mr-2 h-4 w-4" />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow key={`${token.id}-expanded`}>
                          <TableCell colSpan={6} className="bg-muted/30 p-4">
                            <ExpandedQuotaDetail
                              tokenId={token.id}
                              enabled={token.enable}
                              onViewDetail={() => setQuotaModalTokenId(token.id)}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <QuotaDetailModal
        tokenId={quotaModalTokenId || ''}
        tokens={tokens}
        open={!!quotaModalTokenId}
        onOpenChange={(open) => !open && setQuotaModalTokenId(null)}
      />

      <AlertDialog open={!!deleteTokenId} onOpenChange={() => setDeleteTokenId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>确定要删除这个 Token 吗？此操作不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteTokenId && deleteMutation.mutate(deleteTokenId)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showImportDialog} onOpenChange={(open) => { setShowImportDialog(open); if (!open) { setPassword(''); setImportFile(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入 Token</DialogTitle>
            <DialogDescription>
              已选择文件: {importFile?.name || '无'}
              <br />
              请输入管理员密码以确认导入
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>管理员密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入管理员密码"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowImportDialog(false); setPassword(''); setImportFile(null); }}>取消</Button>
            <Button onClick={handleImport} disabled={!password}>
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showExportDialog} onOpenChange={(open) => { setShowExportDialog(open); if (!open) setPassword(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导出 Token</DialogTitle>
            <DialogDescription>请输入管理员密码以确认导出</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>管理员密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入管理员密码"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowExportDialog(false); setPassword(''); }}>取消</Button>
            <Button onClick={handleExport} disabled={!password}>
              确认导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

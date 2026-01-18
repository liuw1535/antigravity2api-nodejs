import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Trash2, RefreshCw, Search, Download, Copy, Check, Info, AlertTriangle, XCircle, Bug, Globe, ChevronDown, Play, Pause } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

type LogLevel = 'info' | 'debug' | 'warn' | 'error' | 'request';

interface LogEntry {
  id?: string;
  timestamp: number;
  level: LogLevel;
  message: string;
}

interface LogStats {
  total: number;
  info: number;
  debug: number;
  warn: number;
  error: number;
  request: number;
}

const LEVEL_CONFIG: Record<LogLevel, { icon: React.ReactNode; label: string; className: string }> = {
  info: {
    icon: <Info className="h-4 w-4" />,
    label: '信息',
    className: 'text-blue-500 bg-blue-500/10',
  },
  debug: {
    icon: <Bug className="h-4 w-4" />,
    label: '调试',
    className: 'text-gray-500 bg-gray-500/10',
  },
  warn: {
    icon: <AlertTriangle className="h-4 w-4" />,
    label: '警告',
    className: 'text-yellow-500 bg-yellow-500/10',
  },
  error: {
    icon: <XCircle className="h-4 w-4" />,
    label: '错误',
    className: 'text-red-500 bg-red-500/10',
  },
  request: {
    icon: <Globe className="h-4 w-4" />,
    label: '请求',
    className: 'text-green-500 bg-green-500/10',
  },
};

const LEVELS: (LogLevel | 'all')[] = ['all', 'info', 'debug', 'warn', 'error', 'request'];

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function highlightText(text: string, keyword: string): React.ReactNode {
  if (!keyword.trim()) return text;
  const parts = text.split(new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === keyword.toLowerCase() ? (
      <mark key={i} className="bg-yellow-300 dark:bg-yellow-700 px-0.5 rounded">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function LogLevelIcon({ level }: { level: LogLevel }) {
  const config = LEVEL_CONFIG[level];
  return (
    <span className={cn('inline-flex items-center justify-center w-6 h-6 rounded', config.className)}>
      {config.icon}
    </span>
  );
}

function LogItem({ log, searchKeyword, onCopy }: { log: LogEntry; searchKeyword: string; onCopy: (text: string) => void }) {
  const config = LEVEL_CONFIG[log.level];
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy(`[${formatTime(log.timestamp)}] [${log.level.toUpperCase()}] ${log.message}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group flex items-start gap-3 py-2 px-3 hover:bg-muted/50 rounded-lg transition-colors">
      <LogLevelIcon level={log.level} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded', config.className)}>
            {log.level.toUpperCase()}
          </span>
          <span className="text-xs text-muted-foreground">{formatTime(log.timestamp)}</span>
        </div>
        <p className="text-sm break-all whitespace-pre-wrap">{highlightText(log.message, searchKeyword)}</p>
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>复制</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function LogsPage() {
  const [currentLevel, setCurrentLevel] = useState<LogLevel | 'all'>('all');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<LogStats>({ total: 0, info: 0, debug: 0, warn: 0, error: 0, request: 0 });
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadLogs = useCallback(async (append = false) => {
    try {
      if (!append) {
        setIsLoading(true);
        setOffset(0);
      }
      const params = new URLSearchParams({
        level: currentLevel,
        search: searchKeyword,
        limit: '100',
        offset: append ? String(offset) : '0',
      });
      const response = await api.get<{ success: boolean; data: { logs: LogEntry[]; total: number } }>(`/logs?${params}`);
      if (response.data) {
        if (append) {
          setLogs((prev) => [...prev, ...response.data.logs]);
        } else {
          setLogs(response.data.logs);
        }
        setTotal(response.data.total);
      }
    } catch {
      toast.error('加载日志失败');
    } finally {
      setIsLoading(false);
    }
  }, [currentLevel, searchKeyword, offset]);

  const loadStats = useCallback(async () => {
    try {
      const response = await api.get<{ success: boolean; data: LogStats }>('/logs/stats');
      if (response.data) {
        setStats(response.data);
      }
    } catch {
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/logs`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket 日志连接已建立');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'init':
              setLogs(data.logs.reverse());
              setTotal(data.logs.length);
              break;
            case 'log':
              if (currentLevel === 'all' || data.log.level === currentLevel) {
                if (!searchKeyword || data.log.message.toLowerCase().includes(searchKeyword.toLowerCase())) {
                  setLogs((prev) => [data.log, ...prev].slice(0, 500));
                  setTotal((prev) => prev + 1);
                }
              }
              setStats((prev) => ({
                ...prev,
                total: prev.total + 1,
                [data.log.level]: (prev[data.log.level as LogLevel] || 0) + 1,
              }));
              break;
            case 'clear':
              setLogs([]);
              setTotal(0);
              setStats({ total: 0, info: 0, debug: 0, warn: 0, error: 0, request: 0 });
              break;
          }
        } catch {
        }
      };

      ws.onclose = () => {
        console.log('WebSocket 日志连接已断开');
        setTimeout(() => {
          if (document.visibilityState === 'visible') {
            connectWebSocket();
          }
        }, 3000);
      };

      ws.onerror = () => {
        loadLogs();
      };

      wsRef.current = ws;
    } catch {
      loadLogs();
    }
  }, [currentLevel, searchKeyword, loadLogs]);

  useEffect(() => {
    loadLogs();
    loadStats();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    loadLogs();
  }, [currentLevel, searchKeyword]);

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshTimerRef.current = setInterval(() => {
        loadLogs();
        loadStats();
      }, 5000);
    } else {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    }
    return () => {
      if (autoRefreshTimerRef.current) {
        clearInterval(autoRefreshTimerRef.current);
      }
    };
  }, [autoRefresh, loadLogs, loadStats]);

  const clearMutation = useMutation({
    mutationFn: () => api.delete('/logs'),
    onSuccess: () => {
      setLogs([]);
      setTotal(0);
      setStats({ total: 0, info: 0, debug: 0, warn: 0, error: 0, request: 0 });
      toast.success('日志已清空');
    },
    onError: () => toast.error('清空失败'),
  });

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('已复制');
  };

  const handleExport = () => {
    if (logs.length === 0) {
      toast.warning('没有日志可导出');
      return;
    }
    const content = logs
      .map((log) => `[${formatTime(log.timestamp)}] [${log.level.toUpperCase()}] ${log.message}`)
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('导出成功');
  };

  const handleLoadMore = () => {
    setOffset((prev) => prev + 100);
    loadLogs(true);
  };

  const hasMore = logs.length < total;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">系统日志</h2>
          <p className="text-muted-foreground">查看系统运行日志</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
            {autoRefresh ? '停止' : '自动刷新'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => { loadLogs(); loadStats(); }}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="mr-2 h-4 w-4" />
            导出
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="mr-2 h-4 w-4" />
                清空
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确认清空</AlertDialogTitle>
                <AlertDialogDescription>确定要清空所有日志吗？此操作不可恢复。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={() => clearMutation.mutate()}>清空</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {LEVELS.map((level) => {
          const count = level === 'all' ? stats.total : stats[level];
          const isActive = currentLevel === level;
          const config = level !== 'all' ? LEVEL_CONFIG[level] : null;

          return (
            <Button
              key={level}
              variant={isActive ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCurrentLevel(level)}
              className={cn(
                'gap-1.5',
                !isActive && config && config.className.replace('bg-', 'hover:bg-')
              )}
            >
              {config && <span className="inline-flex">{config.icon}</span>}
              <span>{level === 'all' ? '全部' : config?.label}</span>
              <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-muted">
                {count}
              </span>
            </Button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>日志列表</CardTitle>
              <CardDescription>
                {currentLevel === 'all' ? '显示全部' : `仅显示${LEVEL_CONFIG[currentLevel].label}`} · 共 {logs.length} / {total} 条
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索日志..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="py-16 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-4">
                <Info className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-muted-foreground">暂无日志</p>
            </div>
          ) : (
            <>
              <ScrollArea className="h-[calc(100vh-300px)] min-h-[300px] max-h-[600px]" ref={scrollRef}>
                <div className="space-y-1">
                  {logs.map((log, index) => (
                    <LogItem
                      key={log.id || `${log.timestamp}-${index}`}
                      log={log}
                      searchKeyword={searchKeyword}
                      onCopy={handleCopy}
                    />
                  ))}
                </div>
              </ScrollArea>
              {hasMore && (
                <div className="pt-4 text-center">
                  <Button variant="outline" onClick={handleLoadMore}>
                    <ChevronDown className="mr-2 h-4 w-4" />
                    加载更多 ({logs.length}/{total})
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Upload, Download, Trash2, MoreHorizontal, Power, PowerOff, FolderSearch, ExternalLink, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
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
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

interface GeminiCliToken {
  id: string;
  email?: string | null;
  projectId?: string | null;
  enable: boolean;
  timestamp: number;
  expires_in: number;
}

type FilterType = 'all' | 'enabled' | 'disabled';

const GEMINICLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINICLI_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform'
].join(' ');

function getOAuthPort() {
  return Math.floor(Math.random() * 10000) + 50000;
}

function getGeminiCliOAuthUrl(port: number) {
  const redirectUri = `http://localhost:${port}/oauth-callback`;
  return `https://accounts.google.com/o/oauth2/v2/auth?` +
    `access_type=offline&client_id=${GEMINICLI_CLIENT_ID}&prompt=consent&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&` +
    `scope=${encodeURIComponent(GEMINICLI_SCOPES)}&state=geminicli_${Date.now()}`;
}

export function GeminiCliPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterType>('all');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showOAuthDialog, setShowOAuthDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importJson, setImportJson] = useState('');
  const [importTab, setImportTab] = useState<'file' | 'json'>('file');
  const [password, setPassword] = useState('');
  const [deleteTokenId, setDeleteTokenId] = useState<string | null>(null);
  const [newToken, setNewToken] = useState({ access_token: '', refresh_token: '' });
  const [oauthPort] = useState(() => getOAuthPort());
  const [callbackUrl, setCallbackUrl] = useState('');
  const [processingOAuth, setProcessingOAuth] = useState(false);

  const { data: tokens = [], isLoading } = useQuery<GeminiCliToken[]>({
    queryKey: ['geminicli-tokens'],
    queryFn: async () => {
      const response = await api.get<{ success: boolean; data: GeminiCliToken[] }>('/geminicli/tokens');
      return response.data;
    },
  });

  const filteredTokens = useMemo(() => {
    if (filter === 'enabled') return tokens.filter((t) => t.enable);
    if (filter === 'disabled') return tokens.filter((t) => !t.enable);
    return tokens;
  }, [tokens, filter]);

  const stats = useMemo(() => ({
    total: tokens.length,
    enabled: tokens.filter((t) => t.enable).length,
    disabled: tokens.filter((t) => !t.enable).length,
  }), [tokens]);

  const addMutation = useMutation({
    mutationFn: (data: { access_token: string; refresh_token: string }) => api.post('/geminicli/tokens', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      setShowAddDialog(false);
      setNewToken({ access_token: '', refresh_token: '' });
      toast.success('Token 添加成功');
    },
    onError: () => toast.error('添加失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (tokenId: string) => api.delete(`/geminicli/tokens/${tokenId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      setDeleteTokenId(null);
      toast.success('Token 已删除');
    },
    onError: () => toast.error('删除失败'),
  });

  const refreshMutation = useMutation({
    mutationFn: (tokenId: string) => api.post(`/geminicli/tokens/${tokenId}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      toast.success('Token 已刷新');
    },
    onError: () => toast.error('刷新失败'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ tokenId, enable }: { tokenId: string; enable: boolean }) =>
      api.put(`/geminicli/tokens/${tokenId}`, { enable }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      toast.success('状态已更新');
    },
    onError: () => toast.error('更新失败'),
  });

  const fetchProjectIdMutation = useMutation({
    mutationFn: (tokenId: string) => api.post(`/geminicli/tokens/${tokenId}/fetch-project-id`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      toast.success('Project ID 获取成功');
    },
    onError: () => toast.error('获取 Project ID 失败'),
  });

  const reloadMutation = useMutation({
    mutationFn: () => api.post('/geminicli/tokens/reload'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      toast.success('已重新加载');
    },
  });

  const handleOAuthProcess = async () => {
    if (!callbackUrl.trim()) {
      toast.error('请输入回调 URL');
      return;
    }

    setProcessingOAuth(true);
    try {
      const url = new URL(callbackUrl);
      const code = url.searchParams.get('code');
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');

      if (!code) {
        toast.error('URL 中未找到授权码');
        return;
      }

      const exchangeResponse = await api.post<{ success: boolean; data: { access_token: string; refresh_token: string } }>('/oauth/exchange', {
        code,
        port: parseInt(port),
        mode: 'geminicli'
      });

      if (exchangeResponse.data) {
        await api.post('/geminicli/tokens', exchangeResponse.data);
        queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
        setShowOAuthDialog(false);
        setCallbackUrl('');
        toast.success('Token 添加成功');
      }
    } catch {
      toast.error('OAuth 处理失败');
    } finally {
      setProcessingOAuth(false);
    }
  };

  const handleExport = async () => {
    if (!password) {
      toast.error('请输入密码');
      return;
    }
    try {
      const response = await api.post<{ success: boolean; data: { tokens: GeminiCliToken[] } }>('/geminicli/tokens/export', { password });
      const exportData = response.data;
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `geminicli-tokens-${new Date().toISOString().slice(0, 10)}.json`;
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
    e.target.value = '';
  };

  const handleImport = async () => {
    if (!password) {
      toast.error('请输入密码');
      return;
    }

    let rawText = '';
    if (importTab === 'file') {
      if (!importFile) {
        toast.error('请选择文件');
        return;
      }
      rawText = await importFile.text();
    } else {
      if (!importJson.trim()) {
        toast.error('请输入 JSON');
        return;
      }
      rawText = importJson;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      toast.error('JSON 解析失败');
      return;
    }

    let data: { tokens: unknown[] } | null = null;
    if (Array.isArray(parsed)) {
      data = { tokens: parsed };
    } else if (parsed?.tokens) {
      data = { tokens: parsed.tokens };
    } else if (parsed?.accounts) {
      data = { tokens: parsed.accounts };
    } else if (parsed?.data?.tokens) {
      data = { tokens: parsed.data.tokens };
    } else if (parsed?.refresh_token || parsed?.refreshToken || parsed?.access_token || parsed?.accessToken) {
      data = { tokens: [parsed] };
    }

    if (!data) {
      toast.error('无效的导入格式');
      return;
    }

    try {
      await api.post('/geminicli/tokens/import', { password, mode: importMode, data });
      queryClient.invalidateQueries({ queryKey: ['geminicli-tokens'] });
      toast.success('导入成功');
      setShowImportDialog(false);
      setImportFile(null);
      setImportJson('');
      setPassword('');
    } catch {
      toast.error('导入失败，请检查密码');
    }
  };

  const isExpired = (token: GeminiCliToken) => Date.now() > token.timestamp + (token.expires_in || 3599) * 1000;

  const oauthUrl = getGeminiCliOAuthUrl(oauthPort);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Gemini CLI Token</h2>
          <p className="text-muted-foreground">
            管理 Gemini CLI Token · 共 {stats.total} 个 ({stats.enabled} 启用)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => reloadMutation.mutate()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重新加载
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowExportDialog(true)}>
            <Download className="mr-2 h-4 w-4" />
            导出
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
            <Upload className="mr-2 h-4 w-4" />
            导入
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowOAuthDialog(true)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            OAuth 授权
          </Button>
          <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-2 h-4 w-4" />
                手动添加
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>手动添加 Token</DialogTitle>
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

      <div className="flex flex-wrap gap-2">
        <Button
          variant={filter === 'all' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('all')}
        >
          全部 ({stats.total})
        </Button>
        <Button
          variant={filter === 'enabled' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('enabled')}
        >
          启用 ({stats.enabled})
        </Button>
        <Button
          variant={filter === 'disabled' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('disabled')}
        >
          禁用 ({stats.disabled})
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Token 列表</CardTitle>
          <CardDescription>
            {filter === 'all' ? '显示全部' : filter === 'enabled' ? '仅显示启用' : '仅显示禁用'} Token
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredTokens.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {filter === 'all' ? '暂无 Token，点击 OAuth 授权或手动添加' : `暂无${filter === 'enabled' ? '启用' : '禁用'}的 Token`}
            </div>
          ) : (
            <>
              {/* Mobile Card View */}
              <div className="grid grid-cols-1 gap-3 md:hidden">
                {filteredTokens.map((token) => {
                  const expiresAt = token.timestamp + (token.expires_in || 3599) * 1000;
                  const expired = isExpired(token);
                  return (
                    <Card key={token.id} className="p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{token.email || '-'}</p>
                          <p className="font-mono text-xs text-muted-foreground">{token.id.substring(0, 16)}...</p>
                        </div>
                        {!token.enable ? (
                          <Badge variant="secondary">已禁用</Badge>
                        ) : expired ? (
                          <Badge variant="destructive">已过期</Badge>
                        ) : (
                          <Badge variant="default">活跃</Badge>
                        )}
                      </div>
                      
                      <div className="space-y-2 text-sm mb-3">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Project ID:</span>
                          <span className="font-mono">{token.projectId || '-'}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">过期时间:</span>
                          <span>{formatDate(expiresAt)}</span>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-2 pt-3 border-t">
                        <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate(token.id)}>
                          <RefreshCw className="mr-1 h-3 w-3" />
                          刷新
                        </Button>
                        {!token.projectId && (
                          <Button variant="outline" size="sm" onClick={() => fetchProjectIdMutation.mutate(token.id)}>
                            <FolderSearch className="mr-1 h-3 w-3" />
                            获取 Project ID
                          </Button>
                        )}
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => toggleMutation.mutate({ tokenId: token.id, enable: !token.enable })}
                        >
                          {token.enable ? <PowerOff className="mr-1 h-3 w-3" /> : <Power className="mr-1 h-3 w-3" />}
                          {token.enable ? '禁用' : '启用'}
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="text-destructive"
                          onClick={() => setDeleteTokenId(token.id)}
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          删除
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>邮箱 / Token ID</TableHead>
                      <TableHead>Project ID</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>过期时间</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTokens.map((token) => {
                      const expiresAt = token.timestamp + (token.expires_in || 3599) * 1000;
                      const expired = isExpired(token);
                      return (
                        <TableRow key={token.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{token.email || '-'}</span>
                              <span className="font-mono text-xs text-muted-foreground">{token.id.substring(0, 16)}...</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            {token.projectId ? (
                              <span className="font-mono text-sm">{token.projectId}</span>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => fetchProjectIdMutation.mutate(token.id)}
                                disabled={fetchProjectIdMutation.isPending}
                              >
                                <FolderSearch className="mr-1 h-3 w-3" />
                                获取
                              </Button>
                            )}
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
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => refreshMutation.mutate(token.id)}>
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                  刷新 Token
                                </DropdownMenuItem>
                                {!token.projectId && (
                                  <DropdownMenuItem onClick={() => fetchProjectIdMutation.mutate(token.id)}>
                                    <FolderSearch className="mr-2 h-4 w-4" />
                                    获取 Project ID
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
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
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={showOAuthDialog} onOpenChange={(open) => { setShowOAuthDialog(open); if (!open) setCallbackUrl(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OAuth 授权</DialogTitle>
            <DialogDescription>通过 Google OAuth 授权添加 Token</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>授权流程</Label>
              <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                <li>点击下方按钮打开 Google 授权页面</li>
                <li>完成授权后，复制浏览器地址栏的完整 URL</li>
                <li>粘贴 URL 到下方输入框并提交</li>
              </ol>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" className="w-full sm:flex-1" onClick={() => window.open(oauthUrl, '_blank')}>
                <ExternalLink className="mr-2 h-4 w-4" />
                打开授权页面
              </Button>
              <Button variant="outline" className="w-full sm:flex-1" onClick={() => { navigator.clipboard.writeText(oauthUrl); toast.success('链接已复制'); }}>
                <Copy className="mr-2 h-4 w-4" />
                复制链接
              </Button>
            </div>
            <div className="space-y-2">
              <Label>回调 URL</Label>
              <Input
                value={callbackUrl}
                onChange={(e) => setCallbackUrl(e.target.value)}
                placeholder="http://localhost:xxxxx/oauth-callback?code=..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOAuthDialog(false)}>取消</Button>
            <Button onClick={handleOAuthProcess} disabled={processingOAuth || !callbackUrl.trim()}>
              {processingOAuth ? '处理中...' : '提交'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={showImportDialog} onOpenChange={(open) => { setShowImportDialog(open); if (!open) { setPassword(''); setImportFile(null); setImportJson(''); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入 Token</DialogTitle>
            <DialogDescription>从文件或 JSON 导入 Token</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex gap-2">
              <Button
                variant={importTab === 'file' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setImportTab('file')}
              >
                文件上传
              </Button>
              <Button
                variant={importTab === 'json' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setImportTab('json')}
              >
                JSON 导入
              </Button>
            </div>

            {importTab === 'file' ? (
              <div className="space-y-2">
                <Label>选择文件</Label>
                <div className="flex gap-2">
                  <Input
                    type="file"
                    accept=".json"
                    onChange={handleFileSelect}
                    className="flex-1"
                  />
                </div>
                {importFile && (
                  <p className="text-sm text-muted-foreground">已选择: {importFile.name}</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label>JSON 内容</Label>
                <Textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder='{"tokens": [...]}'
                  rows={6}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label>导入模式</Label>
              <Select value={importMode} onValueChange={(v: 'merge' | 'replace') => setImportMode(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="merge">合并（保留现有，添加/更新）</SelectItem>
                  <SelectItem value="replace">替换（清空现有，导入新的）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">以 refresh_token 去重：合并会更新同 refresh_token 的记录</p>
            </div>

            <div className="space-y-2">
              <Label>管理员密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="必填"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowImportDialog(false); setPassword(''); setImportFile(null); setImportJson(''); }}>取消</Button>
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

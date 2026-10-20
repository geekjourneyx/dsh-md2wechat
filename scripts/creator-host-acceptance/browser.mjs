import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoAutomaticEffects, assertRestoredArticle } from './support.mjs';

// Only the explicit --browser path imports Playwright and launches a browser.
// These selectors are the real ArticlePanel/CreatorWorkspace accessibility contract.
const panelFor = page => page.getByRole('main', { name: '文章主工作区', exact: true });
const workspaceFor = page => panelFor(page).getByRole('region', { name: '文章工作区', exact: true });
const navigationFor = page => page.getByRole('button', { name: '文章', exact: true });

async function openSessionChat(page, title) {
  // The official host sidebar renders the session title; exclude the panel's select option.
  await page.getByText(title, { exact: true }).and(page.locator(':not(option)')).first().click();
}

async function selectSavedArticle(page, sessionId) {
  await navigationFor(page).click();
  const panel = panelFor(page);
  await panel.getByRole('combobox', { name: '选择会话', exact: true }).selectOption(sessionId);
  await panel.getByRole('button', { name: '继续最近文章', exact: true }).click();
  await workspaceFor(page).getByRole('heading', { name: '离线验收文章', exact: true }).waitFor();
}

async function readView(rpc, identity) {
  const result = await rpc('md2wechat/get', identity);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

async function assertFits(page, width) {
  await page.setViewportSize({ width, height: 1100 });
  const dimensions = await panelFor(page).evaluate(element => ({
    panelWidth: element.clientWidth,
    panelScroll: element.scrollWidth,
    documentWidth: document.documentElement.clientWidth,
    documentScroll: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.panelScroll <= dimensions.panelWidth + 1, `${width}px article panel overflows: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.documentScroll <= dimensions.documentWidth + 1, `${width}px document overflows: ${JSON.stringify(dimensions)}`);
}

export async function exerciseArticlePanel({ page, launch, logs, source, trajectory, rpc, waitFor, readAudit, effects, report }) {
  const errors = [];
  let revisionDiscoveryRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/md2wechat/discoverRevisions') revisionDiscoveryRequests++; });
  const beforeNavigation = await effects();
  await page.goto(launch);
  await navigationFor(page).click();
  const panel = panelFor(page);
  await panel.getByRole('heading', { name: '先选择会话，再开始创作', exact: true }).waitFor();
  assert.equal(await panel.getByRole('combobox', { name: '选择会话', exact: true }).inputValue(), '');
  assert.equal(await workspaceFor(page).count(), 0, 'unselected panel exposed an article');
  await page.screenshot({ path: join(logs, '01-fixed-article-navigation.png'), fullPage: true });
  assertNoAutomaticEffects(beforeNavigation, await effects());
  report.checks.fixedNavigationWithoutSelectedSession = true;

  await panel.getByRole('combobox', { name: '选择会话', exact: true }).selectOption(trajectory.panelSessionId);
  await panel.getByRole('textbox', { name: 'Markdown 路径', exact: true }).fill(source);
  await panel.getByRole('button', { name: '打开 Markdown', exact: true }).click();
  const workspace = workspaceFor(page);
  await workspace.getByRole('heading', { name: '离线验收文章', exact: true }).waitFor();
  const list = await rpc('md2wechat/list', { agentId: trajectory.panelSessionId });
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.value.length, 1);
  const identity = { agentId: trajectory.panelSessionId, articleId: list.value[0].articleId };
  assert.notEqual(identity.articleId, trajectory.articleId, 'separate sessions shared article identity');
  assert.equal((await readAudit()).panelEvents.filter(event => event.type === 'tool/call').length, 0, 'main-panel import required a tool call');
  assertNoAutomaticEffects(beforeNavigation, await effects());
  report.checks.mainPanelImportWithoutToolCall = true;

  await workspace.getByRole('button', { name: '更新预览', exact: true }).click();
  await waitFor(() => workspace.getByRole('button', { name: '审阅当前版本', exact: true }).isEnabled());
  await workspace.getByRole('button', { name: '审阅当前版本', exact: true }).click();
  await workspace.getByRole('button', { name: '已审阅当前版本', exact: true }).waitFor();
  await workspace.frameLocator('iframe').getByText('真实 CLI 接收的本地排版响应。', { exact: true }).waitFor();
  await page.screenshot({ path: join(logs, '02-desktop-main-workspace-1440.png'), fullPage: true });
  const themes = workspace.getByLabel('全部主题');
  const current = await themes.inputValue();
  const alternate = await themes.locator('option').evaluateAll((options, selected) => options.find(option => option.value !== selected)?.value, current);
  assert.ok(alternate);
  await themes.selectOption(alternate);
  await waitFor(() => workspace.getByRole('button', { name: '审阅当前版本', exact: true }).isEnabled());
  await workspace.frameLocator('iframe').locator(`section[data-fixture-theme="${alternate}"]`).waitFor();
  await workspace.getByRole('button', { name: '改进', exact: true }).click();
  await workspace.getByRole('button', { name: '检查阅读体验', exact: true }).click();
  await workspace.getByText('让结尾更清晰', { exact: true }).waitFor({ timeout: 30000 });
  await workspace.getByRole('button', { name: '应用这条建议', exact: true }).click();
  await waitFor(async () => (await readView(rpc, identity)).canUndo);
  await waitFor(() => workspace.getByRole('button', { name: '审阅当前版本', exact: true }).isEnabled());
  const edited = await readView(rpc, identity);
  assert.ok(edited.markdown.includes('先保留原文，再选择主题并检查预览。'));
  await page.screenshot({ path: join(logs, '03-desktop-applied-edit.png'), fullPage: true });
  report.checks.mainPanelThemeAndEdit = true;

  // The same product card must navigate to the primary article, not instantiate an inline editor.
  await openSessionChat(page, '离线验收会话');
  const shortcut = page.getByRole('region', { name: '文章快捷入口', exact: true });
  await shortcut.getByRole('button', { name: '打开文章', exact: true }).click();
  assert.equal(await panel.getByRole('combobox', { name: '选择会话', exact: true }).inputValue(), trajectory.sessionId);
  await workspace.getByRole('heading', { name: '离线验收文章', exact: true }).waitFor();
  assert.equal((await readView(rpc, { agentId: trajectory.sessionId, articleId: trajectory.articleId })).articleId, trajectory.articleId);
  const primaryList = await rpc('md2wechat/list', { agentId: trajectory.sessionId });
  assert.equal(primaryList.value.length, 1, 'shortcut silently created another article');
  report.checks.messageShortcutUsesStableArticle = true;
  await selectSavedArticle(page, identity.agentId);
  assert.equal((await readView(rpc, identity)).markdown, edited.markdown);
  report.checks.switchMainPanelPreservesEdit = true;

  await page.reload();
  await selectSavedArticle(page, identity.agentId);
  assert.equal((await readView(rpc, identity)).markdown, edited.markdown);
  report.checks.pageRefreshPreservesEdit = true;
  for (const width of [360, 768, 1440]) {
    await assertFits(page, width);
    await page.screenshot({ path: join(logs, `04-panel-${width}px.png`), fullPage: true });
  }
  report.checks.responsivePanelWidths = [360, 768, 1440];

  await openSessionChat(page, '历史卡片恢复测试');
  const beforeLegacy = await effects();
  const discoveryBeforeLegacy = revisionDiscoveryRequests;
  await page.getByRole('region', { name: '文章快捷入口', exact: true }).getByRole('button', { name: '打开文章', exact: true }).click();
  await panel.getByRole('heading', { name: '文章暂未恢复', exact: true }).waitFor();
  await page.screenshot({ path: join(logs, '05-historical-card-recovery-prompt.png'), fullPage: true });
  assert.equal(await panel.getByRole('combobox', { name: '选择会话', exact: true }).inputValue(), trajectory.legacySessionId);
  const legacyList = await rpc('md2wechat/list', { agentId: trajectory.legacySessionId });
  assert.equal(legacyList.ok, true);
  assert.deepEqual(legacyList.value, [], 'stale historical ID guessed a replacement article');
  assert.equal(revisionDiscoveryRequests, discoveryBeforeLegacy, 'legacy navigation automatically scanned revisions');
  assertNoAutomaticEffects(beforeLegacy, await effects());
  report.checks.historicalCardExplicitRecovery = true;
  await panel.getByRole('button', { name: '选择已保存版本', exact: true }).click();
  const revisionSelect = panel.getByRole('combobox', { name: '选择已保存文章版本', exact: true });
  await revisionSelect.waitFor();
  assert.equal(await revisionSelect.inputValue(), '', 'historical revision was selected without user choice');
  const recover = panel.getByRole('button', { name: '恢复所选版本', exact: true });
  assert.equal(await recover.isEnabled(), false);
  const manifest = await revisionSelect.locator('option').evaluateAll(options => options.find(option => !!option.value)?.value);
  assert.ok(manifest, 'the fixture workspace has no discoverable saved revision');
  await revisionSelect.selectOption(manifest);
  await recover.click();
  await workspace.getByRole('heading', { name: '离线验收文章', exact: true }).waitFor();
  const recoveredList = await rpc('md2wechat/list', { agentId: trajectory.legacySessionId });
  assert.equal(recoveredList.ok, true, JSON.stringify(recoveredList));
  assert.equal(recoveredList.value.length, 1);
  assert.notEqual(recoveredList.value[0].articleId, trajectory.articleId);
  assert.notEqual(recoveredList.value[0].articleId, identity.articleId);
  assert.equal(revisionDiscoveryRequests, discoveryBeforeLegacy + 1, 'explicit discovery did not make exactly one request');
  assertNoAutomaticEffects(beforeLegacy, await effects());
  await page.screenshot({ path: join(logs, '05b-historical-revision-explicitly-restored.png'), fullPage: true });
  report.checks.historicalRevisionChosenAndRestored = true;
  await selectSavedArticle(page, identity.agentId);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  return { identity, saved: await readView(rpc, identity), errors };
}

export async function restoreArticlePanel({ page, launch, logs, panelState, rpc, waitFor, effects, report, workspace }) {
  const before = await effects();
  await page.goto(launch);
  await selectSavedArticle(page, panelState.identity.agentId);
  const restored = await readView(rpc, panelState.identity);
  assertRestoredArticle(panelState.saved, restored);
  assertNoAutomaticEffects(before, await effects());
  const editor = workspaceFor(page);
  await editor.getByRole('button', { name: '审阅当前版本', exact: true }).waitFor();
  await page.screenshot({ path: join(logs, '06-host-restart-restored-unreviewed.png'), fullPage: true });
  report.checks.browserRestartRestoresUnreviewed = true;
  await editor.getByRole('button', { name: '交付', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: '导出已审阅 HTML', exact: true }).isEnabled(), false);
  await editor.getByRole('button', { name: '更新预览', exact: true }).click();
  await waitFor(() => editor.getByRole('button', { name: '审阅当前版本', exact: true }).isEnabled());
  await editor.getByRole('button', { name: '审阅当前版本', exact: true }).click();
  await editor.getByRole('button', { name: '已审阅当前版本', exact: true }).waitFor();
  await editor.getByLabel('HTML 保存位置').fill('exports/restored-panel.html');
  await editor.getByRole('button', { name: '导出已审阅 HTML', exact: true }).click();
  await waitFor(async () => (await readView(rpc, panelState.identity)).delivery?.kind === 'export');
  const final = await readView(rpc, panelState.identity);
  assert.deepEqual(await readFile(join(workspace, 'exports/restored-panel.html')), await readFile(join(workspace, final.preview.path)));
  await page.screenshot({ path: join(logs, '07-restored-reviewed-export.png'), fullPage: true });
  const after = await effects();
  assert.equal(after.modelRequests, before.modelRequests, 'restoration/export requested a model');
  assert.equal(after.simulatedWrites, before.simulatedWrites, 'local restoration/export uploaded or created a draft');
  assert.equal(panelState.errors.length, 0, JSON.stringify(panelState.errors));
  report.checks.restoredPanelReviewedExport = true;
}

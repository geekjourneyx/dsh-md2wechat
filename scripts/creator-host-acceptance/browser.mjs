import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoAutomaticEffects, assertRestoredArticle } from './support.mjs';

const editorFor = page => page.getByRole('region', { name: '文章工作区', exact: true }).filter({ has: page.getByRole('button', { name: '存为草稿', exact: true }) });
const historyFor = page => page.getByRole('main', { name: '文章主工作区', exact: true });
async function readView(rpc, identity) {
  const result = await rpc('md2wechat/get', identity);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function openArticle(page, title = '空白主面板会话') {
  const group = page.getByText('未分组', { exact: true });
  if (!(await page.getByText(title, { exact: true }).and(page.locator(':not(option)')).first().isVisible()) && await group.isVisible()) await group.click();
  await page.getByText(title, { exact: true }).and(page.locator(':not(option)')).first().click();
  const dock = page.getByRole('region', { name: '本对话文章', exact: true });
  await dock.getByRole('button', { name: '展开文章操作', exact: true }).click();
  await dock.getByRole('button', { name: '打开文章', exact: true }).click();
  await editorFor(page).getByRole('button', { name: '编辑正文', exact: true }).waitFor();
}
async function preview(page, rpc, identity, waitFor) {
  const editor = editorFor(page);
  await editor.getByRole('button', { name: '更新预览', exact: true }).click();
  await waitFor(async () => (await readView(rpc, identity)).preview.status === 'ready');
  await editor.frameLocator('iframe').getByText('真实 CLI 接收的本地排版响应。', { exact: true }).waitFor();
  await waitFor(() => editor.getByRole('button', { name: '更新预览', exact: true }).isEnabled());
}
async function assertFits(page, width) {
  await page.setViewportSize({ width, height: 1100 });
  const dimensions = await editorFor(page).evaluate(element => ({
    width: element.clientWidth, scroll: element.scrollWidth,
    documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, `${width}px editor overflow: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.documentScroll <= dimensions.documentWidth + 1, `${width}px document overflow: ${JSON.stringify(dimensions)}`);
}

export async function exerciseArticlePanel({ page, launch, logs, source, trajectory, rpc, waitFor, readAudit, effects, report }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Source import is exercised through the authenticated API; the current history
  // panel is read-only. Editing belongs to the conversation's native right tab.
  const opened = await rpc('md2wechat/open', { agentId: trajectory.panelSessionId, source, title: '离线验收文章', options: {} });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const identity = { agentId: trajectory.panelSessionId, articleId: opened.value.articleId };
  assert.notEqual(identity.articleId, trajectory.articleId);
  assert.equal((await readAudit()).panelEvents.filter(event => event.type === 'tool/call').length, 0);
  const beforeNavigation = await effects();
  await page.goto(launch);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await welcome.click();
  await openArticle(page);
  assertNoAutomaticEffects(beforeNavigation, await effects());
  report.checks.conversationDockOpensNativeEditor = true;
  await preview(page, rpc, identity, waitFor);
  const editor = editorFor(page);
  const themes = editor.getByRole('combobox', { name: '排版主题', exact: true });
  const current = await themes.inputValue();
  const alternate = await themes.locator('option').evaluateAll((options, selected) => options.find(option => option.value !== selected)?.value, current);
  assert.ok(alternate);
  await themes.selectOption(alternate);
  await waitFor(async () => (await readView(rpc, identity)).theme === alternate);
  await editor.frameLocator('iframe').locator(`section[data-fixture-theme="${alternate}"]`).waitFor();
  await editor.getByRole('button', { name: '编辑标题', exact: true }).click();
  await editor.getByRole('textbox', { name: '文章标题', exact: true }).fill('新版宿主创作验证');
  await editor.getByRole('button', { name: '保存标题', exact: true }).click();
  await waitFor(async () => (await readView(rpc, identity)).title === '新版宿主创作验证');
  await editor.getByRole('button', { name: '编辑正文', exact: true }).click();
  await editor.getByRole('button', { name: '这一段验证真实 CLI 排版与原生工作区。', exact: true }).click();
  await editor.getByRole('textbox', { name: '段落内容', exact: true }).fill('在新版宿主中完成正文编辑并保存。');
  await editor.getByRole('button', { name: '保存这一段', exact: true }).click();
  await waitFor(async () => (await readView(rpc, identity)).markdown.includes('在新版宿主中完成正文编辑并保存。'));
  await editor.getByRole('button', { name: '查看效果', exact: true }).click();
  await editor.getByText('正文配图与文字建议', { exact: true }).click();
  await editor.getByRole('button', { name: '改进阅读体验', exact: true }).click();
  await editor.getByRole('button', { name: '应用这条建议', exact: true }).waitFor();
  await editor.getByRole('button', { name: '应用这条建议', exact: true }).click();
  await waitFor(async () => (await readView(rpc, identity)).markdown.includes('先保留原文，再选择主题并检查预览。'));
  await preview(page, rpc, identity, waitFor);
  report.checks.browserTitleBodyThemeAndSuggestion = true;
  const edited = await readView(rpc, identity);
  await page.screenshot({ path: join(logs, '01-conversation-editor.png'), fullPage: true });
  for (const width of [360, 768, 1440]) {
    await assertFits(page, width);
    await page.screenshot({ path: join(logs, `02-editor-${width}px.png`), fullPage: true });
  }
  report.checks.responsivePanelWidths = [360, 768, 1440];
  await page.getByRole('button', { name: '文章历史', exact: true }).click();
  const history = historyFor(page);
  await history.getByRole('combobox', { name: '选择会话', exact: true }).selectOption(identity.agentId);
  await history.getByRole('button', { name: /新版宿主创作验证/ }).first().click();
  await history.getByRole('button', { name: '回到原对话继续编辑', exact: true }).waitFor();
  assert.equal(await history.getByRole('button', { name: '编辑正文', exact: true }).count(), 0);
  await history.getByRole('button', { name: '回到原对话继续编辑', exact: true }).click();
  await editorFor(page).waitFor();
  assert.equal((await readView(rpc, identity)).markdown, edited.markdown);
  report.checks.readOnlyHistoryReturnsToConversation = true;
  await page.reload();
  await openArticle(page);
  assert.equal((await readView(rpc, identity)).markdown, edited.markdown);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  report.checks.pageRefreshPreservesEdit = true;
  return { identity, saved: await readView(rpc, identity), errors };
}

export async function restoreArticlePanel({ page, launch, logs, panelState, rpc, waitFor, effects, report, workspace }) {
  const before = await effects();
  await page.goto(launch);
  const welcome = page.getByRole('button', { name: '继续', exact: true });
  if (await welcome.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await welcome.click();
  await openArticle(page);
  const restored = await readView(rpc, panelState.identity);
  assertRestoredArticle(panelState.saved, restored);
  assertNoAutomaticEffects(before, await effects());
  const editor = editorFor(page);
  await editor.getByRole('button', { name: '存为草稿', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: '导出已审阅 HTML', exact: true }).isEnabled(), false);
  report.checks.browserRestartRestoresUnreviewed = true;
  await preview(page, rpc, panelState.identity, waitFor);
  await waitFor(() => editor.getByRole('button', { name: '审阅当前版本', exact: true }).isEnabled());
  await editor.getByRole('button', { name: '审阅当前版本', exact: true }).click();
  await editor.getByRole('button', { name: '已审阅当前版本', exact: true }).waitFor();
  await editor.getByLabel('HTML 保存位置').fill('exports/restored-panel.html');
  await editor.getByRole('button', { name: '导出已审阅 HTML', exact: true }).click();
  await waitFor(async () => (await readView(rpc, panelState.identity)).delivery?.kind === 'export');
  const final = await readView(rpc, panelState.identity);
  assert.deepEqual(await readFile(join(workspace, 'exports/restored-panel.html')), await readFile(join(workspace, final.preview.path)));
  await page.screenshot({ path: join(logs, '03-restarted-reviewed-export.png'), fullPage: true });
  const after = await effects();
  assert.equal(after.modelRequests, before.modelRequests);
  assert.equal(after.simulatedWrites, before.simulatedWrites);
  assert.equal(panelState.errors.length, 0, JSON.stringify(panelState.errors));
  report.checks.restoredPanelReviewedExport = true;
}

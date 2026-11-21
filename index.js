/**
 * Tavern-Resource-Hub: Main Extension Entry
 * 幂等挂载酒馆设置区入口与左下角魔法棒菜单入口，启动独立全屏预设·角色卡·世界书管理器。
 */

import { BindingStore } from './binding-store.js';
import { ResourceHubWorkspace } from './ui-workspace.js';

const LAUNCHER_ID = 'tavern_resource_hub_launcher';
const WAND_ITEM_ID = 'tavern_resource_hub_wand_item';

let store = null;
let workspace = null;
let launcherEl = null;
let wandEl = null;
let readyListener = null;
let eventSourceRef = null;
let readyEventName = null;
let generation = 0;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() || null;
}

function updateLauncherSummary() {
    if (!launcherEl || !store) return;
    const sub = launcherEl.querySelector('.trh-drawer-status');
    if (!sub) return;
    const boundCount = store.listBoundResources().length;
    const updateCount = store.listBoundResources().filter(b => b.hasUpdate).length;
    sub.textContent = updateCount > 0
        ? `已绑定 ${boundCount} 个更新源 · 发现 ${updateCount} 个可更新版本`
        : `已绑定 ${boundCount} 个链接更新源`;
}

function mountSettingsLauncher() {
    if (launcherEl?.isConnected || document.getElementById(LAUNCHER_ID)) return;
    const anchor = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!anchor) return;

    launcherEl = document.createElement('section');
    launcherEl.id = LAUNCHER_ID;
    launcherEl.className = 'extension_container';

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'inline-drawer-toggle inline-drawer-header';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'tavern_resource_hub_drawer_content');

    const titleBold = document.createElement('b');
    titleBold.textContent = '资源管理器';

    const chevron = document.createElement('span');
    chevron.className = 'fa-solid fa-circle-chevron-down inline-drawer-icon down';
    chevron.setAttribute('aria-hidden', 'true');

    toggle.append(titleBold, chevron);
    // 展开/收起显示由酒馆宿主委托 .inline-drawer-toggle 处理，此处仅同步 aria-expanded
    toggle.addEventListener('click', () => {
        toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
    });

    const content = document.createElement('div');
    content.id = 'tavern_resource_hub_drawer_content';
    content.className = 'inline-drawer-content';

    const body = document.createElement('div');
    body.className = 'trh-drawer-body';

    const status = document.createElement('div');
    status.className = 'trh-drawer-status';

    const actions = document.createElement('div');
    actions.className = 'trh-drawer-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.id = 'trh_open_workspace_btn';
    openBtn.className = 'menu_button';
    const btnIcon = document.createElement('i');
    btnIcon.className = 'fa-solid fa-up-right-from-square';
    const btnLabel = document.createElement('span');
    btnLabel.textContent = '打开资源管理器';
    openBtn.append(btnIcon, btnLabel);
    openBtn.addEventListener('click', () => {
        workspace?.open();
    });

    actions.append(openBtn);
    body.append(status, actions);
    content.append(body);
    drawer.append(toggle, content);
    launcherEl.append(drawer);
    anchor.append(launcherEl);
    updateLauncherSummary();
}

function mountWandMenuEntry() {
    if (wandEl?.isConnected || document.getElementById(WAND_ITEM_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    wandEl = document.createElement('div');
    wandEl.id = WAND_ITEM_ID;
    wandEl.className = 'extension_container';

    const btn = document.createElement('div');
    btn.id = 'tavern_resource_hub_wand_button';
    btn.className = 'list-group-item flex-container flexGap10 interactable';
    btn.title = '打开资源管理器';
    btn.style.cursor = 'pointer';

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-cubes';
    icon.style.color = '#F5A524';

    const label = document.createElement('span');
    label.textContent = '资源管理器';

    btn.append(icon, label);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const extMenu = document.getElementById('extensionsMenu');
        if (extMenu) extMenu.style.display = 'none';
        workspace?.open();
    });

    wandEl.append(btn);
    menu.prepend(wandEl);
}

function mountAllEntries(currentGen) {
    if (currentGen !== generation) return;
    if (!store) {
        store = new BindingStore({ getContext });
    }
    if (!workspace) {
        workspace = new ResourceHubWorkspace({
            getContext,
            store,
            onStateChange: updateLauncherSummary,
        });
    }
    mountSettingsLauncher();
    mountWandMenuEntry();
}

export function activate() {
    if (readyListener || launcherEl?.isConnected) return;
    const currentGen = ++generation;
    const context = getContext();

    if (context?.eventSource && context?.eventTypes?.APP_READY) {
        eventSourceRef = context.eventSource;
        readyEventName = context.eventTypes.APP_READY;
        readyListener = () => queueMicrotask(() => mountAllEntries(currentGen));
        eventSourceRef.on(readyEventName, readyListener);
    }

    // 兼容扩展在 APP_READY 之后动态加载或模拟环境直接调用
    if (typeof document !== 'undefined') {
        queueMicrotask(() => mountAllEntries(currentGen));
    }
}

export function dispose() {
    generation++;
    if (eventSourceRef && readyListener && readyEventName) {
        eventSourceRef.removeListener(readyEventName, readyListener);
    }
    eventSourceRef = null;
    readyListener = null;
    readyEventName = null;

    workspace?.destroy();
    workspace = null;
    store = null;

    launcherEl?.remove();
    launcherEl = null;
    wandEl?.remove();
    wandEl = null;
}

// 兼容未实现 manifest hooks 的旧版加载器：若模块在浏览器宿主中被直接加载，则在微任务中自检挂载
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    queueMicrotask(() => {
        if (globalThis.SillyTavern?.getContext?.()) {
            activate();
        }
    });
}

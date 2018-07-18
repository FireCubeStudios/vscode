/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/workbench/browser/parts/menubar/menubar.contribution';
import 'vs/css!./media/menubarpart';
import * as nls from 'vs/nls';
import * as browser from 'vs/base/browser/browser';
import { Part } from 'vs/workbench/browser/part';
import { IMenubarService, IMenubarMenu, IMenubarMenuItemAction, IMenubarData } from 'vs/platform/menubar/common/menubar';
import { IMenuService, MenuId, IMenu, SubmenuItemAction } from 'vs/platform/actions/common/actions';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { IWindowService, MenuBarVisibility, IWindowsService } from 'vs/platform/windows/common/windows';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ActionRunner, IActionRunner, IAction, Action } from 'vs/base/common/actions';
import { Builder, $ } from 'vs/base/browser/builder';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { EventType, Dimension } from 'vs/base/browser/dom';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { isWindows, isMacintosh } from 'vs/base/common/platform';
import { Menu, IMenuOptions, SubmenuAction } from 'vs/base/browser/ui/menu/menu';
import { KeyCode } from 'vs/base/common/keyCodes';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { Event, Emitter } from 'vs/base/common/event';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { domEvent } from 'vs/base/browser/event';
import { IRecentlyOpened } from 'vs/platform/history/common/history';
import { IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, getWorkspaceLabel } from 'vs/platform/workspaces/common/workspaces';
import { getPathLabel } from 'vs/base/common/labels';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { RunOnceScheduler } from 'vs/base/common/async';
import { MENUBAR_SELECTION_FOREGROUND, MENUBAR_SELECTION_BACKGROUND, MENUBAR_SELECTION_BORDER, TITLE_BAR_ACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_FOREGROUND, MENU_BACKGROUND, MENU_FOREGROUND, MENU_SELECTION_BACKGROUND, MENU_SELECTION_FOREGROUND, MENU_SELECTION_BORDER } from 'vs/workbench/common/theme';

interface CustomMenu {
	title: string;
	buttonElement: Builder;
	titleElement: Builder;
	actions?: IAction[];
}

enum MenubarState {
	HIDDEN,
	VISIBLE,
	FOCUSED,
	OPEN
}

export class MenubarPart extends Part {

	private keys = [
		'files.autoSave',
		'window.menuBarVisibility',
		'editor.multiCursorModifier',
		'workbench.sideBar.location',
		'workbench.statusBar.visible',
		'workbench.activityBar.visible',
		'window.enableMenuBarMnemonics',
		// 'window.nativeTabs'
	];

	private topLevelMenus: {
		'File': IMenu;
		'Edit': IMenu;
		'Selection': IMenu;
		'View': IMenu;
		'Go': IMenu;
		'Terminal': IMenu;
		'Debug': IMenu;
		'Tasks': IMenu;
		'Window'?: IMenu;
		'Help': IMenu;
		[index: string]: IMenu;
	};

	private topLevelTitles = {
		'File': nls.localize({ key: 'mFile', comment: ['&& denotes a mnemonic'] }, "&&File"),
		'Edit': nls.localize({ key: 'mEdit', comment: ['&& denotes a mnemonic'] }, "&&Edit"),
		'Selection': nls.localize({ key: 'mSelection', comment: ['&& denotes a mnemonic'] }, "&&Selection"),
		'View': nls.localize({ key: 'mView', comment: ['&& denotes a mnemonic'] }, "&&View"),
		'Go': nls.localize({ key: 'mGoto', comment: ['&& denotes a mnemonic'] }, "&&Go"),
		'Terminal': nls.localize({ key: 'mTerminal', comment: ['&& denotes a mnemonic'] }, "Ter&&minal"),
		'Debug': nls.localize({ key: 'mDebug', comment: ['&& denotes a mnemonic'] }, "&&Debug"),
		'Tasks': nls.localize({ key: 'mTasks', comment: ['&& denotes a mnemonic'] }, "&&Tasks"),
		'Help': nls.localize({ key: 'mHelp', comment: ['&& denotes a mnemonic'] }, "&&Help")
	};

	private focusedMenu: {
		index: number;
		holder?: Builder;
		widget?: Menu;
	};

	private customMenus: CustomMenu[];

	private menuUpdater: RunOnceScheduler;
	private actionRunner: IActionRunner;
	private focusToReturn: Builder;
	private container: Builder;
	private recentlyOpened: IRecentlyOpened;
	private updatePending: boolean;
	private _modifierKeyStatus: IModifierKeyStatus;
	private _focusState: MenubarState;

	private _onVisibilityChange: Emitter<Dimension>;

	private initialSizing: {
		menuButtonPaddingLeftRight?: number;
		menubarHeight?: number;
		menubarPaddingLeft?: number;
		menubarPaddingRight?: number;
		menubarFontSize?: number;
	} = {};

	private static MAX_MENU_RECENT_ENTRIES = 5;

	constructor(
		id: string,
		@IThemeService themeService: IThemeService,
		@IMenubarService private menubarService: IMenubarService,
		@IMenuService private menuService: IMenuService,
		@IWindowService private windowService: IWindowService,
		@IWindowsService private windowsService: IWindowsService,
		@IContextKeyService private contextKeyService: IContextKeyService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IEnvironmentService private environmentService: IEnvironmentService
	) {
		super(id, { hasTitle: false }, themeService);

		this.topLevelMenus = {
			'File': this._register(this.menuService.createMenu(MenuId.MenubarFileMenu, this.contextKeyService)),
			'Edit': this._register(this.menuService.createMenu(MenuId.MenubarEditMenu, this.contextKeyService)),
			'Selection': this._register(this.menuService.createMenu(MenuId.MenubarSelectionMenu, this.contextKeyService)),
			'View': this._register(this.menuService.createMenu(MenuId.MenubarViewMenu, this.contextKeyService)),
			'Go': this._register(this.menuService.createMenu(MenuId.MenubarGoMenu, this.contextKeyService)),
			'Terminal': this._register(this.menuService.createMenu(MenuId.MenubarTerminalMenu, this.contextKeyService)),
			'Debug': this._register(this.menuService.createMenu(MenuId.MenubarDebugMenu, this.contextKeyService)),
			'Tasks': this._register(this.menuService.createMenu(MenuId.MenubarTasksMenu, this.contextKeyService)),
			'Help': this._register(this.menuService.createMenu(MenuId.MenubarHelpMenu, this.contextKeyService))
		};

		if (isMacintosh) {
			this.topLevelMenus['Window'] = this._register(this.menuService.createMenu(MenuId.MenubarWindowMenu, this.contextKeyService));
		}

		this.menuUpdater = this._register(new RunOnceScheduler(() => this.doSetupMenubar(), 0));

		this.actionRunner = this._register(new ActionRunner());
		this._register(this.actionRunner.onDidBeforeRun(() => {
			this.setUnfocusedState();
		}));

		this._onVisibilityChange = this._register(new Emitter<Dimension>());

		if (isMacintosh || this.currentTitlebarStyleSetting !== 'custom') {
			for (let topLevelMenuName of Object.keys(this.topLevelMenus)) {
				this._register(this.topLevelMenus[topLevelMenuName].onDidChange(() => this.setupMenubar()));
			}
			this.doSetupMenubar();
		}

		this._focusState = MenubarState.HIDDEN;

		this.windowService.getRecentlyOpened().then((recentlyOpened) => {
			this.recentlyOpened = recentlyOpened;
		});

		this.registerListeners();
	}

	private get currentEnableMenuBarMnemonics(): boolean {
		let enableMenuBarMnemonics = this.configurationService.getValue<boolean>('window.enableMenuBarMnemonics');
		if (typeof enableMenuBarMnemonics !== 'boolean') {
			enableMenuBarMnemonics = true;
		}

		return enableMenuBarMnemonics;
	}

	private get currentMultiCursorSetting(): string {
		return this.configurationService.getValue<string>('editor.multiCursorModifier');
	}

	private get currentAutoSaveSetting(): string {
		return this.configurationService.getValue<string>('files.autoSave');
	}

	private get currentSidebarPosition(): string {
		return this.configurationService.getValue<string>('workbench.sideBar.location');
	}

	private get currentStatusBarVisibility(): boolean {
		let setting = this.configurationService.getValue<boolean>('workbench.statusBar.visible');
		if (typeof setting !== 'boolean') {
			setting = true;
		}

		return setting;
	}

	private get currentActivityBarVisibility(): boolean {
		let setting = this.configurationService.getValue<boolean>('workbench.activityBar.visible');
		if (typeof setting !== 'boolean') {
			setting = true;
		}

		return setting;
	}

	private get currentMenubarVisibility(): MenuBarVisibility {
		return this.configurationService.getValue<MenuBarVisibility>('window.menuBarVisibility');
	}

	private get currentTitlebarStyleSetting(): string {
		return this.configurationService.getValue<string>('window.titleBarStyle');
	}

	private get focusState(): MenubarState {
		return this._focusState;
	}

	private set focusState(value: MenubarState) {
		if (this._focusState >= MenubarState.FOCUSED && value < MenubarState.FOCUSED) {
			// Losing focus, update the menu if needed

			if (this.updatePending) {
				this.menuUpdater.schedule();
				this.updatePending = false;
			}
		}

		if (value === this._focusState) {
			return;
		}

		switch (value) {
			case MenubarState.HIDDEN:
				if (this.isVisible) {
					this.hideMenubar();
				}

				if (this.isOpen) {
					this.cleanupCustomMenu();
				}

				if (this.isFocused) {
					this.focusedMenu = null;

					if (this.focusToReturn) {
						this.focusToReturn.domFocus();
						this.focusToReturn = null;
					}
				}


				break;
			case MenubarState.VISIBLE:
				if (!this.isVisible) {
					this.showMenubar();
				}

				if (this.isOpen) {
					this.cleanupCustomMenu();
				}

				if (this.isFocused) {
					if (this.focusedMenu) {
						this.customMenus[this.focusedMenu.index].buttonElement.domBlur();
					}

					this.focusedMenu = null;

					if (this.focusToReturn) {
						this.focusToReturn.domFocus();
						this.focusToReturn = null;
					}
				}

				break;
			case MenubarState.FOCUSED:
				if (!this.isVisible) {
					this.showMenubar();
				}

				if (this.isOpen) {
					this.cleanupCustomMenu();
				}

				if (this.focusedMenu) {
					this.customMenus[this.focusedMenu.index].buttonElement.domFocus();
				}
				break;
			case MenubarState.OPEN:
				if (!this.isVisible) {
					this.showMenubar();
				}

				if (this.focusedMenu) {
					this.showCustomMenu(this.focusedMenu.index);
				}
				break;
		}

		this._focusState = value;
	}

	private get isVisible(): boolean {
		return this.focusState >= MenubarState.VISIBLE;
	}

	private get isFocused(): boolean {
		return this.focusState >= MenubarState.FOCUSED;
	}

	private get isOpen(): boolean {
		return this.focusState >= MenubarState.OPEN;
	}

	private onDidChangeFullscreen(): void {
		this.updateStyles();
	}

	private onDidChangeWindowFocus(hasFocus: boolean): void {
		if (this.container) {
			if (hasFocus) {
				this.container.removeClass('inactive');
			} else {
				this.container.addClass('inactive');
				this.setUnfocusedState();
			}
		}
	}

	private onConfigurationUpdated(event: IConfigurationChangeEvent): void {
		if (this.keys.some(key => event.affectsConfiguration(key))) {
			this.setupMenubar();
		}
	}

	private setUnfocusedState(): void {
		this.focusState = this.currentMenubarVisibility === 'toggle' ? MenubarState.HIDDEN : MenubarState.VISIBLE;
	}

	private hideMenubar(): void {
		this._onVisibilityChange.fire(new Dimension(0, 0));
		this.container.style('visibility', 'hidden');
	}

	private showMenubar(): void {
		this._onVisibilityChange.fire(this.getMenubarItemsDimensions());
		this.container.style('visibility', null);
	}

	private onModifierKeyToggled(modifierKeyStatus: IModifierKeyStatus): void {
		this._modifierKeyStatus = modifierKeyStatus;
		const altKeyAlone = modifierKeyStatus.lastKeyPressed === 'alt' && !modifierKeyStatus.ctrlKey && !modifierKeyStatus.shiftKey;
		const allModifiersReleased = !modifierKeyStatus.altKey && !modifierKeyStatus.ctrlKey && !modifierKeyStatus.shiftKey;

		if (this.currentMenubarVisibility === 'toggle') {
			if (altKeyAlone) {
				if (!this.isVisible) {
					this.focusState = MenubarState.VISIBLE;
				}
			} else if (!allModifiersReleased && !this.isFocused) {
				this.focusState = MenubarState.HIDDEN;
			}
		}

		if (allModifiersReleased && modifierKeyStatus.lastKeyPressed === 'alt' && modifierKeyStatus.lastKeyReleased === 'alt') {
			if (!this.isFocused) {
				this.focusedMenu = { index: 0 };
				this.focusState = MenubarState.FOCUSED;
			} else if (!this.isOpen) {
				this.setUnfocusedState();
			}
		}

		if (this.currentEnableMenuBarMnemonics && this.customMenus) {
			this.customMenus.forEach(customMenu => {
				let child = customMenu.titleElement.child();
				if (child) {
					child.style('text-decoration', modifierKeyStatus.altKey ? 'underline' : null);
				}
			});
		}
	}

	private onRecentlyOpenedChange(): void {
		this.windowService.getRecentlyOpened().then(recentlyOpened => {
			this.recentlyOpened = recentlyOpened;
			this.setupMenubar();
		});
	}

	private registerListeners(): void {
		// Update when config changes
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));

		// Listen to update service
		// this.updateService.onStateChange(() => this.setupMenubar());

		// Listen for context changes
		this._register(this.contextKeyService.onDidChangeContext(() => this.setupMenubar()));

		// Listen for changes in recently opened menu
		this._register(this.windowsService.onRecentlyOpenedChange(() => { this.onRecentlyOpenedChange(); }));

		// Listen to keybindings change
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.setupMenubar()));

		// These listeners only apply when the custom menubar is being used
		if (!isMacintosh && this.currentTitlebarStyleSetting === 'custom') {
			// Listen to fullscreen changes
			this._register(browser.onDidChangeFullscreen(() => this.onDidChangeFullscreen()));

			// Listen for alt key presses
			this._register(ModifierKeyEmitter.getInstance().event(this.onModifierKeyToggled, this));

			// Listen for window focus changes
			this._register(this.windowService.onDidChangeFocus(e => this.onDidChangeWindowFocus(e)));
		}
	}

	private doSetupMenubar(): void {
		if (!isMacintosh && this.currentTitlebarStyleSetting === 'custom') {
			this.setupCustomMenubar();
		} else {
			this.setupNativeMenubar();
		}
	}

	private setupMenubar(): void {
		this.menuUpdater.schedule();
	}

	private setupNativeMenubar(): void {
		// TODO@sbatten: Remove once native menubar is ready
		if (isMacintosh && isWindows) {
			this.menubarService.updateMenubar(this.windowService.getCurrentWindowId(), this.getMenubarMenus());
		}
	}


	private clearMnemonic(topLevelElement: HTMLElement): void {
		topLevelElement.accessKey = null;
	}

	private registerMnemonic(topLevelElement: HTMLElement, mnemonic: string): void {
		topLevelElement.accessKey = mnemonic.toLocaleLowerCase();
	}

	private setCheckedStatus(action: IAction | IMenubarMenuItemAction) {
		switch (action.id) {
			case 'workbench.action.toggleAutoSave':
				action.checked = this.currentAutoSaveSetting !== 'off';
				break;

			default:
				break;
		}
	}

	private calculateActionLabel(action: IAction | IMenubarMenuItemAction): string {
		let label = action.label;
		switch (action.id) {
			case 'workbench.action.toggleMultiCursorModifier':
				if (this.currentMultiCursorSetting === 'ctrlCmd') {
					label = nls.localize('miMultiCursorAlt', "Switch to Alt+Click for Multi-Cursor");
				} else {
					label = isMacintosh
						? nls.localize('miMultiCursorCmd', "Switch to Cmd+Click for Multi-Cursor")
						: nls.localize('miMultiCursorCtrl', "Switch to Ctrl+Click for Multi-Cursor");
				}
				break;

			case 'workbench.action.toggleSidebarPosition':
				if (this.currentSidebarPosition !== 'right') {
					label = nls.localize({ key: 'miMoveSidebarRight', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Right");
				} else {
					label = nls.localize({ key: 'miMoveSidebarLeft', comment: ['&& denotes a mnemonic'] }, "&&Move Side Bar Left");
				}
				break;

			case 'workbench.action.toggleStatusbarVisibility':
				if (this.currentStatusBarVisibility) {
					label = nls.localize({ key: 'miHideStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Hide Status Bar");
				} else {
					label = nls.localize({ key: 'miShowStatusbar', comment: ['&& denotes a mnemonic'] }, "&&Show Status Bar");
				}
				break;

			case 'workbench.action.toggleActivityBarVisibility':
				if (this.currentActivityBarVisibility) {
					label = nls.localize({ key: 'miHideActivityBar', comment: ['&& denotes a mnemonic'] }, "Hide &&Activity Bar");
				} else {
					label = nls.localize({ key: 'miShowActivityBar', comment: ['&& denotes a mnemonic'] }, "Show &&Activity Bar");
				}
				break;

			default:
				break;
		}

		return this.currentEnableMenuBarMnemonics ? label : label.replace(/&&(.)/g, '$1');
	}

	private createOpenRecentMenuAction(workspace: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier | string, commandId: string, isFile: boolean): IAction {

		let label: string;
		let path: string;

		if (isSingleFolderWorkspaceIdentifier(workspace) || typeof workspace === 'string') {
			label = getPathLabel(workspace, this.environmentService);
			path = workspace;
		} else {
			label = getWorkspaceLabel(workspace, this.environmentService, { verbose: true });
			path = workspace.configPath;
		}

		return new Action(commandId, label, undefined, undefined, (event) => {
			const openInNewWindow = event && ((!isMacintosh && (event.ctrlKey || event.shiftKey)) || (isMacintosh && (event.metaKey || event.altKey)));

			return this.windowService.openWindow([path], {
				forceNewWindow: openInNewWindow,
				forceOpenWorkspaceAsFile: isFile
			});
		});
	}

	private getOpenRecentActions(): IAction[] {
		if (!this.recentlyOpened) {
			return [];
		}

		const { workspaces, files } = this.recentlyOpened;

		const result: IAction[] = [];

		if (workspaces.length > 0) {
			for (let i = 0; i < MenubarPart.MAX_MENU_RECENT_ENTRIES && i < workspaces.length; i++) {
				result.push(this.createOpenRecentMenuAction(workspaces[i], 'openRecentWorkspace', false));
			}

			result.push(new Separator());
		}

		if (files.length > 0) {
			for (let i = 0; i < MenubarPart.MAX_MENU_RECENT_ENTRIES && i < files.length; i++) {
				result.push(this.createOpenRecentMenuAction(files[i], 'openRecentFile', false));
			}

			result.push(new Separator());
		}

		return result;
	}

	private insertActionsBefore(nextAction: IAction, target: IAction[]): void {
		switch (nextAction.id) {
			case 'workbench.action.openRecent':
				target.push(...this.getOpenRecentActions());
				break;

			default:
				break;
		}
	}

	private setupCustomMenubar(): void {
		// Don't update while using the menu
		if (this.isFocused) {
			this.updatePending = true;
			return;
		}

		this.container.attr('role', 'menubar');

		const firstTimeSetup = this.customMenus === undefined;
		if (firstTimeSetup) {
			this.customMenus = [];
		}

		let idx = 0;

		for (let menuTitle of Object.keys(this.topLevelMenus)) {
			const menu: IMenu = this.topLevelMenus[menuTitle];
			let menuIndex = idx++;

			// Create the top level menu button element
			if (firstTimeSetup) {
				const buttonElement = $(this.container).div({ class: 'menubar-menu-button' }).attr({ 'role': 'menu', 'tabindex': 0 });
				buttonElement.attr('aria-label', this.topLevelTitles[menuTitle].replace(/&&(.)/g, '$1'));

				const titleElement = $(buttonElement).div({ class: 'menubar-menu-title', 'aria-hidden': true });

				this.customMenus.push({
					title: menuTitle,
					buttonElement: buttonElement,
					titleElement: titleElement
				});
			}

			// Update the button label to reflect mnemonics
			let displayTitle = this.topLevelTitles[menuTitle].replace(/&&(.)/g, this.currentEnableMenuBarMnemonics ? '<mnemonic>$1</mnemonic>' : '$1');
			$(this.customMenus[menuIndex].titleElement).innerHtml(displayTitle);

			// Clear and register mnemonics due to updated settings
			this.clearMnemonic(this.customMenus[menuIndex].buttonElement.getHTMLElement());
			if (this.currentEnableMenuBarMnemonics) {
				let mnemonic = (/&&(.)/g).exec(this.topLevelTitles[menuTitle]);
				if (mnemonic && mnemonic[1]) {
					this.registerMnemonic(this.customMenus[menuIndex].buttonElement.getHTMLElement(), mnemonic[1]);
				}
			}

			// Update the menu actions
			const updateActions = (menu: IMenu, target: IAction[]) => {
				target.splice(0);
				let groups = menu.getActions();
				for (let group of groups) {
					const [, actions] = group;

					for (let action of actions) {
						this.insertActionsBefore(action, target);
						if (action instanceof SubmenuItemAction) {
							const submenu = this.menuService.createMenu(action.item.submenu, this.contextKeyService);
							const submenuActions = [];
							updateActions(submenu, submenuActions);
							target.push(new SubmenuAction(action.label, submenuActions));
						} else {
							action.label = this.calculateActionLabel(action);
							this.setCheckedStatus(action);
							target.push(action);
						}
					}

					target.push(new Separator());
				}

				target.pop();
			};

			this.customMenus[menuIndex].actions = [];
			if (firstTimeSetup) {
				this._register(menu.onDidChange(() => updateActions(menu, this.customMenus[menuIndex].actions)));
			}

			updateActions(menu, this.customMenus[menuIndex].actions);

			if (firstTimeSetup) {
				this.customMenus[menuIndex].buttonElement.on(EventType.KEY_UP, (e) => {
					let event = new StandardKeyboardEvent(e as KeyboardEvent);
					let eventHandled = true;

					if ((event.equals(KeyCode.DownArrow) || event.equals(KeyCode.Enter)) && !this.isOpen) {
						this.focusedMenu = { index: menuIndex };
						this.focusState = MenubarState.OPEN;
					} else {
						eventHandled = false;
					}

					if (eventHandled) {
						event.preventDefault();
						event.stopPropagation();
					}
				});

				this.customMenus[menuIndex].buttonElement.on(EventType.CLICK, (e) => {
					if (this._modifierKeyStatus && (this._modifierKeyStatus.shiftKey || this._modifierKeyStatus.ctrlKey)) {
						return; // supress keyboard shortcuts that shouldn't conflict
					}

					if (this.isOpen) {
						if (this.isCurrentMenu(menuIndex)) {
							this.setUnfocusedState();
						} else {
							this.cleanupCustomMenu();
							this.showCustomMenu(menuIndex);
						}
					} else {
						this.focusedMenu = { index: menuIndex };
						this.focusState = MenubarState.OPEN;
					}

					e.preventDefault();
					e.stopPropagation();
				});

				this.customMenus[menuIndex].buttonElement.on(EventType.MOUSE_ENTER, () => {
					if (this.isOpen && !this.isCurrentMenu(menuIndex)) {
						this.customMenus[menuIndex].buttonElement.domFocus();
						this.cleanupCustomMenu();
						this.showCustomMenu(menuIndex);
					} else if (this.isFocused && !this.isOpen) {
						this.focusedMenu = { index: menuIndex };
						this.customMenus[menuIndex].buttonElement.domFocus();
					}
				});

			}
		}

		if (firstTimeSetup) {
			this.container.on(EventType.KEY_DOWN, (e) => {
				let event = new StandardKeyboardEvent(e as KeyboardEvent);
				let eventHandled = true;

				if (event.equals(KeyCode.LeftArrow) || (event.shiftKey && event.keyCode === KeyCode.Tab)) {
					this.focusPrevious();
				} else if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.Tab)) {
					this.focusNext();
				} else if (event.equals(KeyCode.Escape) && this.isFocused && !this.isOpen) {
					this.setUnfocusedState();
				} else {
					eventHandled = false;
				}

				if (eventHandled) {
					event.preventDefault();
					event.stopPropagation();
				}
			});

			this._register($(window).on(EventType.CLICK, () => {
				// This click is outside the menubar so it counts as a focus out
				if (this.isFocused) {
					this.setUnfocusedState();
				}
			}));
		}

		this.container.on(EventType.FOCUS_IN, (e) => {
			let event = e as FocusEvent;

			if (event.relatedTarget) {
				if (!this.container.getHTMLElement().contains(event.relatedTarget as HTMLElement)) {
					this.focusToReturn = $(event.relatedTarget as HTMLElement);
				}
			}
		});

		this.container.on(EventType.FOCUS_OUT, (e) => {
			let event = e as FocusEvent;

			if (event.relatedTarget) {
				if (!this.container.getHTMLElement().contains(event.relatedTarget as HTMLElement)) {
					this.focusToReturn = null;
					this.setUnfocusedState();
				}
			}
		});
	}

	private focusPrevious(): void {

		if (!this.focusedMenu) {
			return;
		}

		let newFocusedIndex = (this.focusedMenu.index - 1 + this.customMenus.length) % this.customMenus.length;

		if (newFocusedIndex === this.focusedMenu.index) {
			return;
		}

		if (this.isOpen) {
			this.cleanupCustomMenu();
			this.showCustomMenu(newFocusedIndex);
		} else if (this.isFocused) {
			this.focusedMenu.index = newFocusedIndex;
			this.customMenus[newFocusedIndex].buttonElement.domFocus();
		}
	}

	private focusNext(): void {
		if (!this.focusedMenu) {
			return;
		}

		let newFocusedIndex = (this.focusedMenu.index + 1) % this.customMenus.length;

		if (newFocusedIndex === this.focusedMenu.index) {
			return;
		}

		if (this.isOpen) {
			this.cleanupCustomMenu();
			this.showCustomMenu(newFocusedIndex);
		} else if (this.isFocused) {
			this.focusedMenu.index = newFocusedIndex;
			this.customMenus[newFocusedIndex].buttonElement.domFocus();
		}
	}

	private getMenubarMenus(): IMenubarData {
		let ret: IMenubarData = {};

		for (let topLevelMenuName of Object.keys(this.topLevelMenus)) {
			const menu = this.topLevelMenus[topLevelMenuName];
			let menubarMenu: IMenubarMenu = { items: [] };
			let groups = menu.getActions();
			for (let group of groups) {
				const [, actions] = group;

				actions.forEach(menuItemAction => {
					let menubarMenuItem: IMenubarMenuItemAction = {
						id: menuItemAction.id,
						label: menuItemAction.label,
						checked: menuItemAction.checked,
						enabled: menuItemAction.enabled
					};

					this.setCheckedStatus(menubarMenuItem);
					menubarMenuItem.label = this.calculateActionLabel(menubarMenuItem);

					menubarMenu.items.push(menubarMenuItem);
				});

				menubarMenu.items.push({ id: 'vscode.menubar.separator' });
			}

			if (menubarMenu.items.length > 0) {
				menubarMenu.items.pop();
			}

			ret[topLevelMenuName] = menubarMenu;
		}

		return ret;
	}

	private isCurrentMenu(menuIndex: number): boolean {
		if (!this.focusedMenu) {
			return false;
		}

		return this.focusedMenu.index === menuIndex;
	}

	private cleanupCustomMenu(): void {
		if (this.focusedMenu) {

			if (this.focusedMenu.holder) {
				$(this.focusedMenu.holder.getHTMLElement().parentElement).removeClass('open');
				this.focusedMenu.holder.dispose();
			}

			if (this.focusedMenu.widget) {
				this.focusedMenu.widget.dispose();
			}

			this.focusedMenu = { index: this.focusedMenu.index };
		}
	}

	private showCustomMenu(menuIndex: number): void {
		const customMenu = this.customMenus[menuIndex];

		let menuHolder = $(customMenu.buttonElement).div({ class: 'menubar-menu-items-holder' });

		$(menuHolder.getHTMLElement().parentElement).addClass('open');

		menuHolder.addClass('menubar-menu-items-holder-open context-view');
		menuHolder.style({
			'zoom': `${1 / browser.getZoomFactor()}`,
			'top': `${this.container.getClientArea().height * browser.getZoomFactor()}px`
		});

		let menuOptions: IMenuOptions = {
			getKeyBinding: (action) => this.keybindingService.lookupKeybinding(action.id),
			actionRunner: this.actionRunner,
			// ariaLabel: 'File'
			// actionItemProvider: (action) => { return this._getActionItem(action); }
		};

		let menuWidget = this._register(new Menu(menuHolder.getHTMLElement(), customMenu.actions, menuOptions));

		this._register(menuWidget.onDidCancel(() => {
			this.focusState = MenubarState.FOCUSED;
		}));

		this._register(menuWidget.onDidBlur(() => {
			setTimeout(() => {
				this.cleanupCustomMenu();
			}, 100);
		}));

		menuWidget.focus();

		this.focusedMenu = {
			index: menuIndex,
			holder: menuHolder,
			widget: menuWidget
		};
	}

	public get onVisibilityChange(): Event<Dimension> {
		return this._onVisibilityChange.event;
	}

	public layout(dimension: Dimension): Dimension[] {
		// To prevent zooming we need to adjust the font size with the zoom factor
		if (this.customMenus) {
			if (typeof this.initialSizing.menubarFontSize !== 'number') {
				this.initialSizing.menubarFontSize = parseInt(this.container.getComputedStyle().fontSize, 10);
			}

			if (typeof this.initialSizing.menubarHeight !== 'number') {
				this.initialSizing.menubarHeight = parseInt(this.container.getComputedStyle().height, 10);
			}

			if (typeof this.initialSizing.menubarPaddingLeft !== 'number') {
				this.initialSizing.menubarPaddingLeft = parseInt(this.container.getComputedStyle().paddingLeft, 10);
			}

			if (typeof this.initialSizing.menubarPaddingRight !== 'number') {
				this.initialSizing.menubarPaddingRight = parseInt(this.container.getComputedStyle().paddingRight, 10);
			}

			if (typeof this.initialSizing.menuButtonPaddingLeftRight !== 'number') {
				this.initialSizing.menuButtonPaddingLeftRight = parseInt(this.customMenus[0].buttonElement.getComputedStyle().paddingLeft, 10);
			}

			this.container.style({
				height: `${this.initialSizing.menubarHeight / browser.getZoomFactor()}px`,
				'padding-left': `${this.initialSizing.menubarPaddingLeft / browser.getZoomFactor()}px`,
				'padding-right': `${this.initialSizing.menubarPaddingRight / browser.getZoomFactor()}px`,
				'font-size': `${this.initialSizing.menubarFontSize / browser.getZoomFactor()}px`,
			});

			this.customMenus.forEach(customMenu => {
				customMenu.buttonElement.style({
					'padding': `0 ${this.initialSizing.menuButtonPaddingLeftRight / browser.getZoomFactor()}px`
				});
			});
		}

		if (this.currentMenubarVisibility === 'toggle') {
			this.hideMenubar();
		} else {
			this.showMenubar();
		}

		return super.layout(dimension);
	}

	public getMenubarItemsDimensions(): Dimension {
		if (this.customMenus) {
			const left = this.customMenus[0].buttonElement.getHTMLElement().getBoundingClientRect().left;
			const right = this.customMenus[this.customMenus.length - 1].buttonElement.getHTMLElement().getBoundingClientRect().right;
			return new Dimension(right - left, this.container.getClientArea().height);
		}

		return new Dimension(0, 0);
	}

	public createContentArea(parent: HTMLElement): HTMLElement {
		this.container = $(parent);

		if (!isWindows) {
			return this.container.getHTMLElement();
		}

		// Build the menubar
		if (this.container) {
			this.doSetupMenubar();
		}

		return this.container.getHTMLElement();
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const menubarActiveWindowFgColor = theme.getColor(TITLE_BAR_ACTIVE_FOREGROUND);
	if (menubarActiveWindowFgColor) {
		collector.addRule(`
		.monaco-workbench > .part.menubar > .menubar-menu-button {
			color: ${menubarActiveWindowFgColor};
		}
		`);
	}

	const menubarInactiveWindowFgColor = theme.getColor(TITLE_BAR_INACTIVE_FOREGROUND);
	if (menubarInactiveWindowFgColor) {
		collector.addRule(`
			.monaco-workbench > .part.menubar.inactive > .menubar-menu-button {
				color: ${menubarInactiveWindowFgColor};
			}
		`);
	}


	const menubarSelectedFgColor = theme.getColor(MENUBAR_SELECTION_FOREGROUND);
	if (menubarSelectedFgColor) {
		collector.addRule(`
			.monaco-workbench > .part.menubar > .menubar-menu-button.open,
			.monaco-workbench > .part.menubar > .menubar-menu-button:focus,
			.monaco-workbench > .part.menubar > .menubar-menu-button:hover {
				color: ${menubarSelectedFgColor};
			}
		`);
	}

	const menubarSelectedBgColor = theme.getColor(MENUBAR_SELECTION_BACKGROUND);
	if (menubarSelectedBgColor) {
		collector.addRule(`
			.monaco-workbench > .part.menubar > .menubar-menu-button.open,
			.monaco-workbench > .part.menubar > .menubar-menu-button:focus,
			.monaco-workbench > .part.menubar > .menubar-menu-button:hover {
				background-color: ${menubarSelectedBgColor};
			}
		`);
	}

	const menubarSelectedBorderColor = theme.getColor(MENUBAR_SELECTION_BORDER);
	if (menubarSelectedBorderColor) {
		collector.addRule(`
			.monaco-workbench > .part.menubar > .menubar-menu-button:hover {
				outline: dashed 1px;
			}

			.monaco-workbench > .part.menubar > .menubar-menu-button.open,
			.monaco-workbench > .part.menubar > .menubar-menu-button:focus {
				outline: solid 1px;
			}

			.monaco-workbench > .part.menubar > .menubar-menu-button.open,
			.monaco-workbench > .part.menubar > .menubar-menu-button:focus,
			.monaco-workbench > .part.menubar > .menubar-menu-button:hover {
				outline-offset: -1px;
				outline-color: ${menubarSelectedBorderColor};
			}
		`);
	}

	const menuBgColor = theme.getColor(MENU_BACKGROUND);
	if (menuBgColor) {
		collector.addRule(`
			.monaco-shell .monaco-menu .monaco-action-bar.vertical,
			.monaco-shell .monaco-menu .monaco-action-bar.vertical .action-item {
				background-color: ${menuBgColor};
			}
		`);
	}

	const menuFgColor = theme.getColor(MENU_FOREGROUND);
	if (menuFgColor) {
		collector.addRule(`
			.monaco-shell .monaco-menu .monaco-action-bar.vertical,
			.monaco-shell .monaco-menu .monaco-action-bar.vertical .action-item {
				color: ${menuFgColor};
			}
		`);
	}

	const selectedMenuItemBgColor = theme.getColor(MENU_SELECTION_BACKGROUND);
	if (menuBgColor) {
		collector.addRule(`
			.monaco-shell .monaco-menu .monaco-action-bar.vertical .action-item.focused {
					background-color: ${selectedMenuItemBgColor};
				}
		`);
	}

	const selectedMenuItemFgColor = theme.getColor(MENU_SELECTION_FOREGROUND);
	if (selectedMenuItemFgColor) {
		collector.addRule(`
		.monaco-shell .monaco-menu .monaco-action-bar.vertical .action-item.focused {
				color: ${selectedMenuItemFgColor};
			}
		`);
	}

	const selectedMenuItemBorderColor = theme.getColor(MENU_SELECTION_BORDER);
	if (selectedMenuItemBorderColor) {
		collector.addRule(`
		.monaco-shell .monaco-menu .monaco-action-bar.vertical .action-item.focused {
				border: 1px solid ${selectedMenuItemBorderColor};
			}
		`);
	}
});

type ModifierKey = 'alt' | 'ctrl' | 'shift';

interface IModifierKeyStatus {
	altKey: boolean;
	shiftKey: boolean;
	ctrlKey: boolean;
	lastKeyPressed?: ModifierKey;
	lastKeyReleased?: ModifierKey;
}


class ModifierKeyEmitter extends Emitter<IModifierKeyStatus> {

	private _subscriptions: IDisposable[] = [];
	private _keyStatus: IModifierKeyStatus;
	private static instance: ModifierKeyEmitter;

	private constructor() {
		super();

		this._keyStatus = {
			altKey: false,
			shiftKey: false,
			ctrlKey: false
		};

		this._subscriptions.push(domEvent(document.body, 'keydown')(e => {
			if (e.altKey && !this._keyStatus.altKey) {
				this._keyStatus.lastKeyPressed = 'alt';
			} else if (e.ctrlKey && !this._keyStatus.ctrlKey) {
				this._keyStatus.lastKeyPressed = 'ctrl';
			} else if (e.shiftKey && !this._keyStatus.shiftKey) {
				this._keyStatus.lastKeyPressed = 'shift';
			} else {
				this._keyStatus.lastKeyPressed = undefined;
			}

			this._keyStatus.altKey = e.altKey;
			this._keyStatus.ctrlKey = e.ctrlKey;
			this._keyStatus.shiftKey = e.shiftKey;

			if (this._keyStatus.lastKeyPressed) {
				this.fire(this._keyStatus);
			}
		}));
		this._subscriptions.push(domEvent(document.body, 'keyup')(e => {
			if (!e.altKey && this._keyStatus.altKey) {
				this._keyStatus.lastKeyReleased = 'alt';
			} else if (!e.ctrlKey && this._keyStatus.ctrlKey) {
				this._keyStatus.lastKeyReleased = 'ctrl';
			} else if (!e.shiftKey && this._keyStatus.shiftKey) {
				this._keyStatus.lastKeyReleased = 'shift';
			} else {
				this._keyStatus.lastKeyReleased = undefined;
			}

			this._keyStatus.altKey = e.altKey;
			this._keyStatus.ctrlKey = e.ctrlKey;
			this._keyStatus.shiftKey = e.shiftKey;

			if (this._keyStatus.lastKeyReleased) {
				this.fire(this._keyStatus);
			}
		}));

		this._subscriptions.push(domEvent(window, 'blur')(e => {
			this._keyStatus.lastKeyPressed = undefined;
			this._keyStatus.lastKeyReleased = undefined;
			this._keyStatus.altKey = false;
			this._keyStatus.shiftKey = false;
			this._keyStatus.shiftKey = false;

			this.fire(this._keyStatus);
		}));
	}

	static getInstance() {
		if (!ModifierKeyEmitter.instance) {
			ModifierKeyEmitter.instance = new ModifierKeyEmitter();
		}

		return ModifierKeyEmitter.instance;
	}

	dispose() {
		super.dispose();
		this._subscriptions = dispose(this._subscriptions);
	}
}
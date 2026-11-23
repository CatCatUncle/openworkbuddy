// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
'use strict';

// Generate a reviewable brief in the browser; sending remains a visitor action.
(() => {
  const form = document.querySelector('#enterprise-evaluation');
  const result = document.querySelector('#evaluation-result');
  const brief = document.querySelector('#evaluation-brief');
  const heading = document.querySelector('#evaluation-result-title');
  const email = document.querySelector('#evaluation-email');
  const copy = document.querySelector('#evaluation-copy');
  const scale = document.querySelector('#evaluation-scale');
  if (!(form instanceof HTMLFormElement) || !(result instanceof HTMLElement) ||
      !(brief instanceof HTMLElement) || !(heading instanceof HTMLElement) ||
      !(email instanceof HTMLAnchorElement) || !(copy instanceof HTMLButtonElement) ||
      !(scale instanceof HTMLInputElement)) return;

  /** @param {string} name */
  const value = (name) => {
    const field = form.querySelector('[name="' + name + '"]');
    return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value.trim() : '';
  };
  const deliverySelected = () => form.querySelector('[name="purpose"]:checked')?.getAttribute('value') === 'delivery';
  form.addEventListener('input', () => { result.hidden = true; });
  form.addEventListener('change', () => {
    result.hidden = true;
    scale.placeholder = deliverySelected()
      ? '例如：先验证 1 个客户场景，计划服务约 10 家客户'
      : '例如：先给 5 人试跑，后续团队约 30 人';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const fields = ['task', 'audience', 'scale', 'timeline'];
    const empty = fields.find((name) => !value(name));
    if (empty) {
      const field = form.querySelector('[name="' + empty + '"]');
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.value = '';
        field.reportValidity();
      }
      return;
    }
    const purpose = deliverySelected() ? '给客户交付 / 产品集成' : '团队内部使用';
    const source = new URLSearchParams(location.search).get('from');
    const sourceNames = { video: '视频演示', homepage: '产品首页', enterprise: '企业方案', 'trial-guide': '项目试用与验收说明' };
    const sourceLabel = source && Object.prototype.hasOwnProperty.call(sourceNames, source)
      ? sourceNames[/** @type {keyof typeof sourceNames} */ (source)] : '';
    const text = [
      'OpenWorkBuddy 企业评估 / 一次任务试跑',
      '用途：' + purpose,
      '',
      '1. 要跑什么任务：\n' + value('task'),
      '2. 给谁用：' + value('audience'),
      '3. 大约多少人或客户：' + value('scale'),
      '4. 什么时候要用：' + value('timeline'),
      '',
      '希望围绕这项任务确认样例资料、试跑范围、验收方式与费用。',
      ...(sourceLabel ? ['来源：' + sourceLabel] : []),
    ].join('\n');
    brief.textContent = text;
    copy.textContent = '复制需求到微信';
    email.href = 'mailto:contact@aijentra.com?subject=' + encodeURIComponent('OpenWorkBuddy 企业评估｜' + purpose) + '&body=' + encodeURIComponent(text);
    result.hidden = false;
    heading.focus();
  });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(brief.textContent || '');
      copy.textContent = '已复制，添加 agi_smith 后粘贴发送';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(brief);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      copy.textContent = '请复制已选中的需求，发到微信 agi_smith';
    }
  });
})();

/**
 * 角色管理路由。
 */

import {
  CreateRoleBodySchema,
  RoleListQuerySchema,
  UpdateRoleBodySchema,
  type CreatedIdResponse,
  type ItemsEnvelope,
  type OkResponse,
  type RoleListResponse,
  type RoleWire,
} from '@app/contracts';
import { Hono } from 'hono';
import type { RoleService } from '../../application/role/role.service.js';
import { getActor, type AppEnv } from './env.js';
import { requirePermission } from './middleware/require-permission.js';
import { toPageWire, toRoleDetailWire, toRoleWire } from './wire.js';
import { validate } from './validator.js';

export interface RoleRoutesDeps {
  service: RoleService;
}

export const buildRoleRoutes = (deps: RoleRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.get(
    '/',
    requirePermission('role:read'),
    validate('query', RoleListQuerySchema),
    async (c) => {
      const query = c.req.valid('query');
      const page = await deps.service.list(query);
      const body: RoleListResponse = toPageWire(page, query, toRoleWire);
      return c.json(body);
    },
  );

  /**
   * 角色下拉选项。
   * [注意] 这是固定路径,必须注册在 GET /:id 之前 —— 否则 'options' 会被当成 id。
   *
   * 权限用 user:read 而不是 role:read: 调这个接口的场景是"编辑用户时选角色",
   * 一个只能管用户的人不该被迫也拥有查看角色管理页的权限。
   */
  app.get('/options', requirePermission('user:read'), async (c) => {
    const roles = await deps.service.listForPicker();
    const body: ItemsEnvelope<{ id: string; code: string; name: string }> = { items: roles };
    return c.json(body);
  });

  app.post(
    '/create',
    requirePermission('role:manage'),
    validate('json', CreateRoleBodySchema),
    async (c) => {
      const result = await deps.service.create(c.req.valid('json'), getActor(c));
      const body: CreatedIdResponse = result;
      return c.json(body, 201);
    },
  );

  // ── :id 路由 ──

  app.get('/:id', requirePermission('role:read'), async (c) => {
    const role = await deps.service.get(c.req.param('id'));
    const body: RoleWire = toRoleDetailWire(role);
    return c.json(body);
  });

  app.post(
    '/:id/update',
    requirePermission('role:manage'),
    validate('json', UpdateRoleBodySchema),
    async (c) => {
      await deps.service.update(c.req.param('id'), c.req.valid('json'), getActor(c));
      const body: OkResponse = { ok: true };
      return c.json(body);
    },
  );

  app.post('/:id/delete', requirePermission('role:manage'), async (c) => {
    await deps.service.remove(c.req.param('id'), getActor(c));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  return app;
};

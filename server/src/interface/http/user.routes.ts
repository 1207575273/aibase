/**
 * 用户管理路由。
 */

import {
  CreateUserBodySchema,
  ResetPasswordBodySchema,
  UpdateUserBodySchema,
  UserListQuerySchema,
  type CreatedIdResponse,
  type OkResponse,
  type UserListResponse,
  type UserWire,
} from '@app/contracts';
import { Hono } from 'hono';
import type { UserService } from '../../application/user/user.service.js';
import { getActor, type AppEnv } from './env.js';
import { requirePermission } from './middleware/require-permission.js';
import { toPageWire, toUserWire } from './wire.js';
import { validate } from './validator.js';

export interface UserRoutesDeps {
  service: UserService;
}

export const buildUserRoutes = (deps: UserRoutesDeps): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  app.get(
    '/',
    requirePermission('user:read'),
    validate('query', UserListQuerySchema),
    async (c) => {
      const query = c.req.valid('query');
      const page = await deps.service.list(query, getActor(c));
      const body: UserListResponse = toPageWire(page, query, toUserWire);
      return c.json(body);
    },
  );

  app.post(
    '/create',
    requirePermission('user:manage'),
    validate('json', CreateUserBodySchema),
    async (c) => {
      const result = await deps.service.create(c.req.valid('json'), getActor(c));
      const body: CreatedIdResponse = result;
      return c.json(body, 201);
    },
  );

  // ── :id 路由,排在固定路径之后 ──

  app.get('/:id', requirePermission('user:read'), async (c) => {
    const user = await deps.service.get(c.req.param('id'), getActor(c));
    const body: UserWire = toUserWire(user);
    return c.json(body);
  });

  app.post(
    '/:id/update',
    requirePermission('user:manage'),
    validate('json', UpdateUserBodySchema),
    async (c) => {
      await deps.service.update(c.req.param('id'), c.req.valid('json'), getActor(c));
      const body: OkResponse = { ok: true };
      return c.json(body);
    },
  );

  app.post(
    '/:id/reset-password',
    requirePermission('user:manage'),
    validate('json', ResetPasswordBodySchema),
    async (c) => {
      const { newPassword } = c.req.valid('json');
      await deps.service.resetPassword(c.req.param('id'), newPassword, getActor(c));
      const body: OkResponse = { ok: true };
      return c.json(body);
    },
  );

  app.post('/:id/delete', requirePermission('user:manage'), async (c) => {
    await deps.service.remove(c.req.param('id'), getActor(c));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  return app;
};

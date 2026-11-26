import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';
import { AppException } from './core/errors/app.exception.js';

export const API_PREFIX = 'api/v1';

/**
 * Everything applied to the app outside the module graph. Shared by main.ts and the e2e tests,
 * so the tests exercise the same pipes, prefix and headers as production.
 */
export function setupApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.useLogger(app.get(Logger));
  // AWS load balancers sit in front of the app: trust one proxy hop for the client IP.
  app.set('trust proxy', 1);
  app.use(helmet());
  // helmet marks every response "same-origin only", which stops the web app (another origin) from showing a picture in an <img>. The pictures anyone
  // may read by their address (profile photos and conference logos, signature and certificate pictures) are meant to be shown by the web app, so only
  // those routes say "cross-origin"; everything else keeps the strict default.
  const PUBLIC_PICTURES =
    /^\/api\/v1\/(?:files\/public|certificates\/(?:signature|asset)-image\/[^/]+)\/?$/;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && PUBLIC_PICTURES.test(req.path)) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    next();
  });
  app.use(cookieParser());
  // A certificate design is one JSON document that can hold a logo, so JSON bodies may be larger than Express's 100 kb default.
  // The design itself is capped at 2 MB by the certificates service.
  app.useBodyParser('json', { limit: '3mb' });
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    // The refresh token travels in a cookie.
    credentials: true,
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: ['health', 'health/ready', '.well-known/jwks.json'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        AppException.validation(
          'Some fields are invalid.',
          flattenValidationErrors(errors),
        ),
    }),
  );
  app.enableShutdownHooks();

  const swaggerEnabled =
    config.get('SWAGGER_ENABLED', { infer: true }) ??
    config.get('NODE_ENV', { infer: true }) !== 'production';
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Smartconferu API')
        .setVersion('1')
        .addBearerAuth({
          type: 'http',
          scheme: 'bearer',
          description: 'Access token from /auth/sign-in or /auth/refresh',
        })
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }
}

function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): { field: string; errors: string[] }[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints
      ? [{ field, errors: Object.values(error.constraints) }]
      : [];
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

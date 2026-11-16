import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import {
  AccessTokenService,
  EVENT_TICKET_TTL_SECONDS,
} from '../../core/auth/access-token.service.js';
import type { AuthUser } from '../../core/auth/auth-user.js';
import { CurrentUser, Public } from '../../core/auth/auth.decorators.js';
import { DatabaseService } from '../../core/database/database.service.js';
import { users } from '../../core/database/schema/index.js';
import { AppException, ErrorCode } from '../../core/errors/app.exception.js';
import { decodeCursor } from '../../core/http/pagination.js';
import {
  type LiveEvent,
  LiveEventsService,
} from '../../core/realtime/live-events.service.js';

/** A comment line keeps proxies and load balancers from closing an idle stream. */
const HEARTBEAT_MS = 25_000;
/** A stream ends after this long; the app reconnects with a new ticket (signed-out users drop off). */
const STREAM_MAX_MS = 60 * 60_000;
/** How long the browser waits before reconnecting after a dropped stream. */
const RETRY_MS = 5000;

class EventTicketResponse {
  @ApiProperty({ description: 'Put it in the stream URL: /me/events?ticket=…' })
  ticket: string;
  @ApiProperty({
    example: EVENT_TICKET_TTL_SECONDS,
    description: 'Seconds it stays valid for opening the stream.',
  })
  expiresIn: number;
}

/**
 * Live events (Server-Sent Events) for the signed-in user: a new bell notification arrives the
 * moment it is saved. The browser's EventSource can't send an Authorization header, so the app
 * first gets a ticket with its access token:
 *
 *   const { ticket } = await api.post('/me/events/ticket');
 *   const events = new EventSource(`${API}/me/events?ticket=${ticket}`);
 *   events.addEventListener('notification', (e) => show(JSON.parse(e.data)));
 *
 * Events: `ready` ({ unread }) first, then `notification` ({ notification, unread }) with an id;
 * `expired` when the stream ends after an hour. After a drop or `expired`, the app gets a new
 * ticket and reopens with `&lastEventId=<last id>`: the missed notifications are sent first.
 */
@ApiTags('notifications')
@Controller('me/events')
export class LiveEventsController {
  constructor(
    private readonly live: LiveEventsService,
    private readonly tokens: AccessTokenService,
    private readonly database: DatabaseService,
  ) {}

  @Post('ticket')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'A one-minute ticket to open my live-event stream' })
  @ApiOkResponse({ type: EventTicketResponse })
  async ticket(@CurrentUser() user: AuthUser): Promise<EventTicketResponse> {
    return {
      ticket: await this.tokens.issueEventTicket(user),
      expiresIn: EVENT_TICKET_TTL_SECONDS,
    };
  }

  @Get()
  @Public()
  @ApiProduces('text/event-stream')
  @ApiQuery({
    name: 'ticket',
    required: false,
    description: 'From POST /me/events/ticket (or send a bearer token).',
  })
  @ApiQuery({
    name: 'lastEventId',
    required: false,
    description: 'Resume after this event (or the Last-Event-ID header).',
  })
  @ApiOperation({
    summary:
      'My live events (Server-Sent Events): new notifications as they happen',
  })
  async stream(
    @Req() req: Request,
    @Res() res: Response,
    @Query('ticket') ticket: string | undefined,
    @Query('lastEventId') lastEventIdQuery: string | undefined,
    @Headers('last-event-id') lastEventIdHeader: string | undefined,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    const user = await this.authenticate(ticket, authorization);
    const lastEventId = lastEventIdHeader || lastEventIdQuery;
    const resumeFrom = lastEventId ? decodeCursor(lastEventId) : undefined;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx and similar proxies would otherwise hold events back.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`retry: ${RETRY_MS}\n\n`);

    let open = true;
    const sent = new Set<string>();
    const write = (event: LiveEvent) => {
      if (!open) {
        return;
      }
      if (event.id) {
        if (sent.has(event.id)) {
          return; // the same notification from the catch-up and live
        }
        sent.add(event.id);
        res.write(`id: ${event.id}\n`);
      }
      res.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
    };
    const end = (reason?: string) => {
      if (!open) {
        return;
      }
      if (reason) {
        res.write(`event: expired\ndata: ${JSON.stringify({ reason })}\n\n`);
      }
      open = false;
      cleanup();
      res.end();
    };

    // Subscribe first, then read what was missed, so nothing falls between the two.
    const unsubscribe = this.live.subscribe({
      userId: user.id,
      send: write,
      close: (reason) => end(reason),
    });
    const heartbeat = setInterval(
      () => open && res.write(': ping\n\n'),
      HEARTBEAT_MS,
    );
    const maxAge = setTimeout(() => end('reconnect'), STREAM_MAX_MS);
    heartbeat.unref();
    maxAge.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      clearTimeout(maxAge);
      unsubscribe();
    };
    req.on('close', () => {
      open = false;
      cleanup();
    });

    write(await this.live.ready(user.id));
    if (resumeFrom) {
      for (const event of await this.live.catchUp(user.id, resumeFrom)) {
        write(event);
      }
    }
  }

  /** The ticket, or a bearer access token; the account must still be active. */
  private async authenticate(
    ticket: string | undefined,
    authorization: string | undefined,
  ): Promise<AuthUser> {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
    let user: AuthUser;
    try {
      if (ticket) {
        user = await this.tokens.verifyEventTicket(ticket);
      } else if (bearer) {
        user = await this.tokens.verify(bearer);
      } else {
        throw new Error('missing');
      }
    } catch {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_TOKEN,
        'Your live-event ticket is missing or has expired. Get a new one and reconnect.',
      );
    }
    const [row] = await this.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, user.id), eq(users.status, 'active')));
    if (!row) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.AUTH_INVALID_TOKEN,
        'This account is no longer active.',
      );
    }
    return user;
  }
}

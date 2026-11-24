import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { S3FileStorage } from './s3-file-storage.js';

type Command = { input: Record<string, unknown> };

/** A stand-in for the S3 client: records each command and answers with `reply`. */
function fakeClient(reply: (command: Command) => unknown = () => ({})) {
  const sent: Command[] = [];
  const client = {
    send: vi.fn((command: Command) => {
      sent.push(command);
      try {
        return Promise.resolve(reply(command));
      } catch (error) {
        return Promise.reject(error as Error);
      }
    }),
  };
  return {
    sent,
    storage: new S3FileStorage(client as unknown as S3Client, 'papers-bucket'),
  };
}

describe('S3FileStorage', () => {
  it('uploads with the content type and reads the file back', async () => {
    const { sent, storage } = fakeClient((command) =>
      command instanceof GetObjectCommand
        ? {
            Body: {
              transformToByteArray: () =>
                Promise.resolve(new Uint8Array([37, 80, 68, 70])),
            },
          }
        : {},
    );

    await storage.put(
      'c1/s1/paper.pdf',
      Buffer.from('%PDF'),
      'application/pdf',
    );
    const data = await storage.get('c1/s1/paper.pdf');

    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0].input).toMatchObject({
      Bucket: 'papers-bucket',
      Key: 'c1/s1/paper.pdf',
      ContentType: 'application/pdf',
    });
    expect(sent[1]).toBeInstanceOf(GetObjectCommand);
    expect(data.toString('latin1')).toBe('%PDF');
  });

  it('deletes one file', async () => {
    const { sent, storage } = fakeClient();
    await storage.delete('u1/photo-1.png');
    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[0].input).toEqual({
      Bucket: 'papers-bucket',
      Key: 'u1/photo-1.png',
    });
  });

  it('deletes a folder page by page, matching only that folder', async () => {
    const pages = [
      {
        Contents: [{ Key: 'u1/a.png' }, { Key: 'u1/b.png' }],
        IsTruncated: true,
        NextContinuationToken: 't2',
      },
      { Contents: [{ Key: 'u1/c.png' }], IsTruncated: false },
    ];
    let page = 0;
    const { sent, storage } = fakeClient((command) =>
      command instanceof ListObjectsV2Command ? pages[page++] : {},
    );

    await storage.deleteFolder('u1');

    const lists = sent.filter((c) => c instanceof ListObjectsV2Command);
    const deletes = sent.filter((c) => c instanceof DeleteObjectsCommand);
    expect(lists.map((c) => c.input)).toEqual([
      { Bucket: 'papers-bucket', Prefix: 'u1/', ContinuationToken: undefined },
      { Bucket: 'papers-bucket', Prefix: 'u1/', ContinuationToken: 't2' },
    ]);
    expect(deletes.map((c) => c.input.Delete)).toEqual([
      { Objects: [{ Key: 'u1/a.png' }, { Key: 'u1/b.png' }], Quiet: true },
      { Objects: [{ Key: 'u1/c.png' }], Quiet: true },
    ]);
  });

  it('treats an empty folder as nothing to do', async () => {
    const { sent, storage } = fakeClient(() => ({
      Contents: [],
      IsTruncated: false,
    }));
    await storage.deleteFolder('c1/s1/');
    expect(sent).toHaveLength(1);
    expect(sent[0].input.Prefix).toBe('c1/s1/');
  });

  it('reports files the store could not delete', async () => {
    const { storage } = fakeClient((command) =>
      command instanceof ListObjectsV2Command
        ? { Contents: [{ Key: 'u1/a.png' }], IsTruncated: false }
        : { Errors: [{ Key: 'u1/a.png', Code: 'AccessDenied' }] },
    );
    await expect(storage.deleteFolder('u1')).rejects.toThrow(
      /Could not delete 1 file\(s\) under u1\/: u1\/a.png AccessDenied/,
    );
  });

  it('refuses keys that the local driver would refuse', async () => {
    const { sent, storage } = fakeClient();
    for (const key of ['', '/abs.pdf', '../x.pdf', 'a/../b.pdf', 'a\\b.pdf']) {
      await expect(
        storage.put(key, Buffer.alloc(1), 'application/pdf'),
      ).rejects.toThrow(/Invalid storage key/);
    }
    expect(sent).toHaveLength(0);
  });

  it('explains why the bucket cannot be used', async () => {
    const failing = (status: number) =>
      fakeClient((command) => {
        expect(command).toBeInstanceOf(HeadBucketCommand);
        throw Object.assign(new Error('UnknownError'), {
          $metadata: { httpStatusCode: status },
        });
      }).storage;

    await expect(failing(403).verify()).rejects.toThrow(
      /bucket "papers-bucket": access denied/,
    );
    await expect(failing(404).verify()).rejects.toThrow(
      /the bucket does not exist/,
    );
    await expect(fakeClient().storage.verify()).resolves.toBeUndefined();
  });
});

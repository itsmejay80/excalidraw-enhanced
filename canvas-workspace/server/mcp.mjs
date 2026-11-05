import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';

export async function canvasMcp({ catalog, workers, source, publicUrl, changed }) {
  const { tools } = await import(pathToFileURL(path.join(source, 'dist/core/mcp-tools.js')).href);
  const text = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const details = canvas => ({ ...canvas, url: `${publicUrl}/c/${canvas.id}` });
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'omarchy-canvases', version: '1.0.0', description: 'Create and edit separate saved Excalidraw canvases. List or create a canvas first, then supply its canvasId to every drawing tool.' });
    const register = (name, description, schema, callback) => {
      server.registerTool(name, { description, inputSchema: fromJsonSchema(schema) }, async args => {
        try { return await callback(args); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
      });
    };
    const nameSchema = { type: 'string', minLength: 1, maxLength: 120 };
    const canvasId = { type: 'string', description: 'ID returned by list_canvases or create_canvas. Each canvas is isolated; use the intended ID on every call.' };
    register('list_canvases', 'List saved canvases, their IDs, names, and permanent browser URLs.', { type: 'object', properties: {} }, () => text({ canvases: catalog.list().map(details) }));
    register('create_canvas', 'Create a new, empty, separately saved canvas. Returns its canvasId and browser URL. Existing canvases are preserved.', { type: 'object', properties: { name: nameSchema }, required: ['name'] }, ({ name }) => {
      const canvas = catalog.create(name);
      return text({ ...details(canvas), canvasId: canvas.id });
    });
    register('get_canvas', 'Get the name, permanent URL, and metadata for a canvas.', { type: 'object', properties: { canvasId }, required: ['canvasId'] }, args => text(details(catalog.get(args.canvasId))));
    register('rename_canvas', 'Rename a saved canvas without changing its ID, URL, or drawing.', { type: 'object', properties: { canvasId, name: nameSchema }, required: ['canvasId', 'name'] }, args => text(details(catalog.update(args.canvasId, { name: args.name }))));
    for (const tool of tools) {
      // Canvas IDs are explicit instead of a shared mutable 'selected canvas'.
      // Concurrent clients cannot silently switch one another's destination.
      register(tool.name, `${tool.description || ''} Operates only on the supplied canvasId.`, {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, canvasId },
        required: [...(tool.inputSchema.required || []), 'canvasId']
      }, async args => {
        const { canvasId: id, ...input } = args;
        catalog.get(id);
        const result = await workers.tool(id, tool.name, input);
        if (!result.isError && !/^(get_|query_|describe_|read_|export_)/.test(tool.name)) changed(id);
        return result;
      });
    }
    return server;
  });
  return {
    handler,
    async serve(req, res, next) {
      try {
        const request = new Request(`http://${req.headers.host}${req.originalUrl}`, {
          method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: JSON.stringify(req.body ?? {}) })
        });
        const response = await handler.fetch(request);
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (response.body) {
          const stream = Readable.fromWeb(response.body);
          stream.on('error', error => res.destroy(error));
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        } else res.end();
      } catch (error) { next(error); }
    }
  };
}

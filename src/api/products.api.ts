import { HttpError, type HttpClient } from "../http-client.js";
import type { Product, ApiResponse, PaginatedResponse } from "../types/api.js";
import { BaseResource, cache, type ListParams } from "./base-resource.js";
import { IdMap } from "../crm/id-map.js";

const LIST_PAGE_SIZE = 100;

type CrmCatalogueItem = { id: string; name: string; sku: string; unitPrice: string };

function toRikProduct(row: CrmCatalogueItem, id: number): Product {
  return {
    id,
    name: row.name,
    code: row.sku,
    sales_price: Number(row.unitPrice),
  };
}

function switchedOff(): never {
  throw new HttpError("switched off in the CRM-MCP: the catalogue is maintained in the CRM", 501, "POST", "/products");
}

/**
 * RIK's `ProductsApi` over the CRM's read-only catalogue (`GET /catalogue`,
 * spec §2.3). `basePath` ("/products") stays only as the cache-key prefix;
 * every write is switched off — the catalogue is maintained in the CRM.
 */
export class ProductsApi extends BaseResource<Product> {
  private readonly idMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/products");
    this.idMap = new IdMap(client);
  }

  private async loadCatalogue(): Promise<Product[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:all`);
    const cached = cache.get<Product[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;
    const rows = await this.client.get<CrmCatalogueItem[]>("/catalogue");
    const ids = await this.idMap.toNumeric("product", rows.map(r => r.id));
    const products = rows.map((r, i) => toRikProduct(r, ids[i]!));
    cache.setIfSameGeneration(cacheKey, products, gen, 120);
    return products;
  }

  async list(params?: ListParams): Promise<PaginatedResponse<Product>> {
    const requestedPage = params?.page ?? 1;
    const all = await this.loadCatalogue();
    const totalPages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    const items = all.slice((requestedPage - 1) * LIST_PAGE_SIZE, requestedPage * LIST_PAGE_SIZE);
    return { current_page: requestedPage, total_pages: totalPages, items };
  }

  async get(id: number): Promise<Product> {
    const all = await this.loadCatalogue();
    const found = all.find(p => p.id === id);
    if (!found) throw new HttpError(`CRM 404 on GET /catalogue/${id}`, 404, "GET", `/catalogue/${id}`);
    return found;
  }

  async create(_data: Partial<Product>): Promise<ApiResponse> {
    return switchedOff();
  }

  async update(_id: number, _data: Partial<Product>): Promise<ApiResponse> {
    return switchedOff();
  }

  async delete(_id: number): Promise<ApiResponse> {
    return switchedOff();
  }

  async deactivate(_id: number): Promise<ApiResponse> {
    return switchedOff();
  }

  async restore(_id: number): Promise<ApiResponse> {
    return switchedOff();
  }
}

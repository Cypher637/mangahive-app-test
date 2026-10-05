package app.mangahive.mihon.spi;

/**
 * One real upstream Source, seen from the host. JDK types only: the host never touches upstream classes.
 * JSON shapes (all fields optional unless stated):
 *  search  -> {"mangas":[{"url"(req),"title","thumbnailUrl"}],"hasNextPage":bool}
 *  details -> {"url","title","author","artist","description","genres":[str] (split from SManga.genre),"status":int,"thumbnailUrl","memo":{}}
 *  chapters-> {"chapters":[{"url"(req),"name","number":num,"dateUpload":long,"scanlator","memo":{}}]}
 *  pages   -> {"pages":[{"index":int,"url","imageUrl"}]}
 *
 * Stage 6: every call carries the request's {@link RequestContext}. The gateway MUST make it current for every HTTP call
 * the Source issues while serving this call (including calls made from other threads/coroutines it starts), so those
 * calls reach {@link HttpBroker#execute} with the same id and cancel scope. A call that cannot be attributed to a
 * request is refused by the gateway (fail closed).
 */
public interface SourceGateway {
    /** Entry class (Source or SourceFactory) that produced this source. */
    String entryClassName();
    long sourceId();
    String name();
    String lang();
    boolean supportsLatest();
    /** null when the source has no base URL concept. */
    String baseUrl();

    String searchJson(RequestContext ctx, int page, String query) throws GatewayException;
    String detailsJson(RequestContext ctx, String mangaUrl) throws GatewayException;
    String chaptersJson(RequestContext ctx, String mangaUrl) throws GatewayException;
    String pagesJson(RequestContext ctx, String chapterUrl) throws GatewayException;

    /**
     * Stage 6.5. tachiyomix 1.6 {@code SManga.memo}/{@code SChapter.memo} are source-internal JSON objects the Source expects back
     * on later calls. Details/chapters/pages JSON now carry them as {@code "memo":{...}} and these overloads hand them back
     * ({@code null} = none). Defaults ignore the memo so existing implementers keep compiling.
     */
    default String detailsJson(RequestContext ctx, String mangaUrl, String mangaMemoJson) throws GatewayException { return detailsJson(ctx, mangaUrl); }
    default String chaptersJson(RequestContext ctx, String mangaUrl, String mangaMemoJson) throws GatewayException { return chaptersJson(ctx, mangaUrl); }
    default String pagesJson(RequestContext ctx, String chapterUrl, String chapterMemoJson) throws GatewayException { return pagesJson(ctx, chapterUrl); }
}

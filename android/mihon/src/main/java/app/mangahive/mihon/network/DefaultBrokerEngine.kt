package app.mangahive.mihon.network

import android.content.Context
import app.mangahive.mihon.net.BrokerEngine
import app.mangahive.mihon.net.CookieStore
import app.mangahive.mihon.net.DestinationPolicy
import app.mangahive.mihon.net.Deadlines
import app.mangahive.mihon.net.ResourceGovernor
import app.mangahive.mihon.net.FileCookieStorage
import java.io.File

/** Production assembly. The ONE place a policy, transport and cookie store are tied together. */
object DefaultBrokerEngine {
    fun create(context: Context): BrokerEngine = create(File(context.filesDir, "mihon_cookies"))

    fun create(
        cookieDir: File,
        policy: DestinationPolicy = DestinationPolicy.production(),
        governor: ResourceGovernor = ResourceGovernor(),
    ): BrokerEngine = BrokerEngine(
        policy,
        OkHttpTransport(),
        CookieStore(FileCookieStorage(cookieDir)) { System.currentTimeMillis() },
        BrokerEngine.Limits(),
        governor,
        Deadlines.shared(),
    )
}

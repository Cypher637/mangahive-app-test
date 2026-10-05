package eu.kanade.tachiyomi.source.model

import kotlinx.serialization.json.JsonObject

@Suppress("UNUSED", "PropertyName")
interface SChapter {
    var url: String

    var name: String

    var chapter_number: Float

    var scanlator: String?

    var date_upload: Long

    var memo: JsonObject

    companion object {
        fun create(): SChapter = SChapterImpl()
    }
}

@Suppress("PropertyName")
internal class SChapterImpl : SChapter {
    override lateinit var url: String
    override lateinit var name: String
    override var chapter_number: Float = -1f
    override var scanlator: String? = null
    override var date_upload: Long = 0
    override var memo: JsonObject = JsonObject(emptyMap())
}

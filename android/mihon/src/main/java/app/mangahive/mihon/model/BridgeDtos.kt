package app.mangahive.mihon.model

import org.json.JSONArray
import org.json.JSONObject

object BridgeSchema {
    const val API_VERSION = "1"

    fun ok(requestId: String, operation: String, data: JSONObject?): String {
        val o = JSONObject()
        o.put("apiVersion", API_VERSION)
        o.put("requestId", requestId)
        o.put("operation", operation)
        o.put("success", true)
        o.put("data", data ?: JSONObject.NULL)
        o.put("error", JSONObject.NULL)
        return o.toString()
    }

    fun fail(requestId: String, operation: String, code: String, message: String, retryable: Boolean = false): String {
        val err = JSONObject()
        err.put("code", code)
        err.put("message", message)
        err.put("retryable", retryable)
        val o = JSONObject()
        o.put("apiVersion", API_VERSION)
        o.put("requestId", requestId)
        o.put("operation", operation)
        o.put("success", false)
        o.put("data", JSONObject.NULL)
        o.put("error", err)
        return o.toString()
    }

    fun listToJson(list: List<Map<String, Any?>>): JSONArray {
        val arr = JSONArray()
        list.forEach { arr.put(mapToJson(it)) }
        return arr
    }

    fun mapToJson(map: Map<String, Any?>): JSONObject {
        val o = JSONObject()
        map.forEach { (k, v) ->
            when (v) {
                null -> o.put(k, JSONObject.NULL)
                is Map<*, *> -> @Suppress("UNCHECKED_CAST") o.put(k, mapToJson(v as Map<String, Any?>))
                is List<*> -> {
                    val a = JSONArray()
                    v.forEach { item ->
                        when (item) {
                            is Map<*, *> -> @Suppress("UNCHECKED_CAST") a.put(mapToJson(item as Map<String, Any?>))
                            else -> a.put(item)
                        }
                    }
                    o.put(k, a)
                }
                else -> o.put(k, v)
            }
        }
        return o
    }
}

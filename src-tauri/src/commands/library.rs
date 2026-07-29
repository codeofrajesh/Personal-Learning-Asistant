//! IPC commands for Library drill-down navigation (Section 8, Pages 2–5).
//!
//! One command per page — Goal, Subject, Chapter — each bundling the breadcrumb
//! ancestry with the child list in a single round-trip (mirrors `dashboard_data`:
//! Section 11 favours one IPC call per page render). Materials are the leaf; opening
//! one is the Video Player milestone, so no material-open command lives here yet.
//!
//! Each command follows the established pattern: `db: State<Db>`, work inside
//! `db.with`, return `AppResult<T>`.

use serde::Serialize;
use tauri::State;

use crate::db::queries::{
    self, ChapterDetail, ChapterSummary, CourseLesson, GoalDetail, MaterialRow, SubjectDetail,
    SubjectSummary,
};
use crate::db::Db;
use crate::utils::errors::AppResult;

/// Goal page payload: the goal header + its subjects.
#[derive(Debug, Serialize)]
pub struct GoalView {
    pub goal: GoalDetail,
    pub subjects: Vec<SubjectSummary>,
}

/// Subject page payload: the subject (with parent goal for the breadcrumb) + chapters.
#[derive(Debug, Serialize)]
pub struct SubjectView {
    pub subject: SubjectDetail,
    pub chapters: Vec<ChapterSummary>,
}

/// Chapter page payload: the chapter (with full ancestry) + its materials.
#[derive(Debug, Serialize)]
pub struct ChapterView {
    pub chapter: ChapterDetail,
    pub materials: Vec<MaterialRow>,
}

/// Everything the Goal page needs: header + subjects grid.
#[tauri::command]
pub fn goal_view(db: State<'_, Db>, goal_id: i64) -> AppResult<GoalView> {
    db.with(|conn| {
        Ok(GoalView {
            goal: queries::goal_detail(conn, goal_id)?,
            subjects: queries::list_subjects(conn, goal_id)?,
        })
    })
}

/// Everything the Subject page needs: header + parent goal + chapters list.
#[tauri::command]
pub fn subject_view(db: State<'_, Db>, subject_id: i64) -> AppResult<SubjectView> {
    db.with(|conn| {
        Ok(SubjectView {
            subject: queries::subject_detail(conn, subject_id)?,
            chapters: queries::list_chapters(conn, subject_id)?,
        })
    })
}

/// Everything the Chapter page needs: header + full ancestry + materials list.
#[tauri::command]
pub fn chapter_view(db: State<'_, Db>, chapter_id: i64) -> AppResult<ChapterView> {
    db.with(|conn| {
        Ok(ChapterView {
            chapter: queries::chapter_detail(conn, chapter_id)?,
            materials: queries::list_materials(conn, chapter_id)?,
        })
    })
}

/// Course-detail payload (Courses re-architecture, Step 4): the subject header + parent
/// goal (for the breadcrumb/back nav), the chapter list (sticky headers + counts), a
/// flattened sequence-ordered list of every lesson across all chapters, and a
/// subject-wide active-material rollup for the progress ring.
#[derive(Debug, Serialize)]
pub struct CourseView {
    pub subject: SubjectDetail,
    pub chapters: Vec<ChapterSummary>,
    pub lessons: Vec<CourseLesson>,
    /// Active materials across the subject (summed from chapter counts; honest zero).
    pub material_count: i64,
    /// Completed materials across the subject (summed from chapter counts).
    pub completed_count: i64,
}

/// Everything the Course detail page needs in one round-trip.
#[tauri::command]
pub fn course_view(db: State<'_, Db>, subject_id: i64) -> AppResult<CourseView> {
    db.with(|conn| {
        // Resolve the subject first so a bad id fails fast with NotFound (the child
        // queries would just return empty vecs on a non-existent subject).
        let subject = queries::subject_detail(conn, subject_id)?;
        let chapters = queries::list_chapters(conn, subject_id)?;
        let lessons = queries::course_lessons(conn, subject_id)?;
        // Roll up active-material counts from the chapter summaries (consistent with
        // how the rest of the app counts — active only, honest zeros).
        let material_count = chapters.iter().map(|c| c.material_count).sum();
        let completed_count = chapters.iter().map(|c| c.completed_count).sum();
        Ok(CourseView {
            subject,
            chapters,
            lessons,
            material_count,
            completed_count,
        })
    })
}

/// The goal id of the most recently watched material, or `None` if nothing has been
/// opened. Used by the Courses page to default the goal pill tab to the active goal.
#[tauri::command]
pub fn get_recent_goal(db: State<'_, Db>) -> AppResult<Option<i64>> {
    db.with(|conn| queries::get_recent_goal(conn))
}

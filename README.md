# 4K Screen Recorder (Browser)

אפליקציית הקלטת מסך מבוססת דפדפן עם סביבת מרצה (Lecturer Workspace) להצגת PDF, כתיבה חופשית על שקפים, מצלמת מרצה צפה והורדת הקלטה בפורמט `WebM` - ללא התקנה וללא העלאת קבצים לשרת.

## דמו

- אתר פעיל: [https://ymtzioni.github.io/browser-4k-cam/](https://ymtzioni.github.io/browser-4k-cam/)

## פיצ'רים מרכזיים

- טעינת קובץ PDF והצגת שקפים במסך מלא.
- ניווט שקפים בזמן אמת (כולל קיצורי מקלדת).
- שכבת אנוטציות (ציור/כתיבה על השקפים).
- בועת מצלמה נגררת עם התאמת צורה וגודל.
- בדיקת מיקרופון לפני הקלטה + מד עוצמה חי.
- הקלטת ה־Workspace כווידאו `WebM` ישירות בדפדפן.
- פריסה אוטומטית ל־GitHub Pages דרך GitHub Actions.

## טכנולוגיות

- `React 18` + `TypeScript`
- `Vite 5`
- `Tailwind CSS`
- `Radix UI`
- `React Router`
- `pdfjs-dist`
- `Vitest` + `Testing Library`

## דרישות מערכת

- `Node.js 22+` מומלץ.
- `npm 10+` מומלץ.
- דפדפן מודרני: Chrome / Edge / Firefox / Opera.

## התקנה והרצה מקומית

```bash
npm install
npm run dev
```

ברירת המחדל של סביבת הפיתוח: `http://localhost:8080`.

## סקריפטים חשובים

- `npm run dev` - הרצת סביבת פיתוח.
- `npm run build` - בניית גרסת Production לתיקיית `dist`.
- `npm run preview` - צפייה מקומית בבילד מוכן.
- `npm run lint` - בדיקות ESLint.
- `npm run test` - הרצת טסטים חד־פעמית.
- `npm run test:watch` - הרצת טסטים במצב צפייה.

## מבנה פרויקט (בקצרה)

- `src/pages/Lecturer.tsx` - סביבת המרצה הראשית.
- `src/components/lecturer/` - רכיבי הקלטה, אנוטציות, מצלמה וכלי שליטה.
- `src/pages/Index.tsx` - מסך בית/נחיתה.
- `vite.config.ts` - הגדרות Vite, כולל `base` ל־GitHub Pages.
- `.github/workflows/deploy-pages.yml` - בילד ופריסה אוטומטית ל־Pages.

## פריסה ל-GitHub Pages

הפרויקט מוגדר לפריסה באמצעות GitHub Actions.

1. ב־GitHub: `Settings -> Pages`.
2. תחת `Source` לבחור **GitHub Actions**.
3. כל `push` ל־`main` מפעיל את ה־workflow:
   - בנייה (`npm run build`)
   - העלאת `dist` כ־artifact
   - פריסה ל־GitHub Pages

> הערה: עבור SPA נוצר גם `404.html` (עותק של `index.html`) כדי לתמוך בניווט נתיבים.

## פרטיות ואבטחה

- קבצי PDF ונתוני ההקלטה מעובדים מקומית בדפדפן.
- אין העלאה יזומה של תוכן ההקלטה לשרת מתוך האפליקציה.

## תקלות נפוצות

- **שגיאת 404 על `main.tsx` ב־Pages**  
  בדרך כלל זה אומר ש־Pages מוגדר ל־`Deploy from branch` במקום `GitHub Actions`.

- **אין קול בהקלטה**  
  יש לוודא הרשאת מיקרופון בדפדפן ולבדוק את מד המיקרופון לפני התחלת הקלטה.

- **המצלמה לא מוצגת**  
  יש לאשר הרשאת מצלמה בדפדפן ולבדוק שלא בשימוש ע"י אפליקציה אחרת.

## רישיון

כרגע לא הוגדר קובץ `LICENSE` בפרויקט. אם הפרויקט מיועד לשימוש ציבורי, מומלץ להוסיף רישיון מתאים.
